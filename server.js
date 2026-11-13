"use strict";

/**
 * Local market-data server for the SPY & QQQ sentiment app.
 *  - Serves the React UI (bundles app.jsx with esbuild automatically)
 *  - Fetches Yahoo Finance SERVER-SIDE (no CORS, no public CORS proxies)
 *  - Works on Node 16+ (falls back to node:https if global fetch is missing)
 */

const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");

let express;
try {
  express = require("express");
} catch {
  console.error("\n[FATAL] Missing dependency 'express'.  ->  run:  npm install\n");
  process.exit(1);
}

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || "127.0.0.1";

const PUBLIC_DIR = path.join(__dirname, "public");
const ENTRY_JSX = path.join(__dirname, "app.jsx");
const INDEX_HTML = path.join(PUBLIC_DIR, "index.html");
const STYLES_CSS = path.join(PUBLIC_DIR, "styles.css");

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
app.disable("x-powered-by");

const YAHOO_HOSTS = [
  "https://query1.finance.yahoo.com",
  "https://query2.finance.yahoo.com",
];
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const RANGE = process.env.YAHOO_RANGE || "2y";
const CACHE_TTL_MS = 30_000;

const cache = new Map();
const inflight = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 1) Bundling (esbuild) — done automatically, no separate build step
 * ------------------------------------------------------------------ */
let bundle = { mtime: 0, code: null };

function normalizeEncoding(dir) {
  const skip = new Set(["node_modules", "public", ".git", ".vscode", "dist", ".git"]);
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) { normalizeEncoding(p); continue; }
    if (!/\.(jsx?|cjs|mjs|js|css|html|json)$/.test(f)) continue;
    try {
      const buf = fs.readFileSync(p);
      const nul = buf.filter((b) => b === 0).length;
      const utf16 = (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xfe) || nul > buf.length * 0.02;
      if (utf16) {
        const txt = buf.toString("utf16le").replace(/^\uFEFF/, "").replace(/\u0000/g, "");
        fs.writeFileSync(p, Buffer.from(txt, "utf8"));
        console.log(`[server] ${f}: re-encoded UTF-16/garbled -> UTF-8`);
      }
    } catch (e) {
      console.log(`[server] could not normalise ${f}: ${e.message}`);
    }
  }
}

function getBundle() {
  if (!fs.existsSync(ENTRY_JSX)) {
    throw new Error(`app.jsx not found at ${ENTRY_JSX}`);
  }
  const mtime = fs.statSync(ENTRY_JSX).mtimeMs;
  if (bundle.code && bundle.mtime === mtime) return bundle.code;

  let esbuild;
  try {
    esbuild = require("esbuild");
  } catch {
    throw new Error("esbuild is not installed.  ->  run:  npm install");
  }

  const out = esbuild.buildSync({
    entryPoints: [ENTRY_JSX],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["es2019"],
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });

  bundle = { mtime, code: out.outputFiles[0].text };
  console.log("[server] app.jsx bundled OK (" + (bundle.code.length / 1024).toFixed(0) + " kB)");
  return bundle.code;
}

try {
  getBundle();
} catch (e) {
  console.error("[server] WARNING: bundle failed at startup ->", e.message);
}

/* ------------------------------------------------------------------ *
 * 2) Yahoo Finance fetching
 * ------------------------------------------------------------------ */
function nodeFetchJSON(url, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      { headers: { "User-Agent": USER_AGENT, Accept: "application/json,text/plain,*/*" }, timeout },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(nodeFetchJSON(res.headers.location, timeout));
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error("Invalid JSON from upstream"));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Upstream request timed out")));
    req.on("error", reject);
  });
}

async function httpJSON(url, timeout = 12000) {
  if (typeof fetch === "function") {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "application/json,text/plain,*/*" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
  return nodeFetchJSON(url, timeout);
}

function normalizeChart(result, symbol) {
  const meta = result.meta || {};
  const timestamps = result.timestamp || [];
  const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};

  const bars = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = q.close ? q.close[i] : null;
    if (typeof c !== "number" || !Number.isFinite(c)) continue;
    const o = typeof q.open?.[i] === "number" ? q.open[i] : c;
    const h = typeof q.high?.[i] === "number" ? q.high[i] : Math.max(o, c);
    const l = typeof q.low?.[i] === "number" ? q.low[i] : Math.min(o, c);
    const v = typeof q.volume?.[i] === "number" ? q.volume[i] : 0;
    bars.push({ t: timestamps[i] * 1000, o, h, l, c, v }); // t = epoch ms
  }

  if (bars.length < 50) {
    throw new Error(`Only ${bars.length} daily bars for ${symbol} (need 50+)`);
  }

  const closes = bars.map((b) => b.c);
  const price = typeof meta.regularMarketPrice === "number" ? meta.regularMarketPrice : closes[closes.length - 1];

  // chartPreviousClose = close BEFORE the whole range (1y ago) -> NOT a 1-day change
  const previousClose =
    typeof meta.previousClose === "number"
      ? meta.previousClose
      : typeof meta.regularMarketPreviousClose === "number"
      ? meta.regularMarketPreviousClose
      : closes.length >= 2
      ? closes[closes.length - 2]
      : price;

  const change = price - previousClose;
  return {
    symbol,
    name: meta.shortName || meta.longName || symbol,
    price,
    previousClose,
    change,
    changePercent: previousClose ? (change / previousClose) * 100 : 0,
    closes,
    bars,                       // <-- NEW: OHLCV for the charts
    currency: meta.currency || "USD",
    exchange: meta.fullExchangeName || meta.exchangeName || "",
    marketTime: meta.regularMarketTime ? meta.regularMarketTime * 1000 : null,
    source: "yahoo",
  };
}

async function fetchYahoo(symbol) {
  let lastError = null;
  for (const host of YAHOO_HOSTS) {
    const url =
      `${host}/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?interval=1d&range=${RANGE}&includePrePost=false`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const json = await httpJSON(url, 12000);
        const result = json && json.chart && json.chart.result && json.chart.result[0];
        if (!result) {
          lastError = new Error(
            (json && json.chart && json.chart.error && json.chart.error.description) ||
              `No data for ${symbol}`
          );
          continue;
        }
        return normalizeChart(result, symbol);
      } catch (err) {
        lastError = err && err.name === "AbortError" ? new Error("Upstream timed out (12s)") : err;
        if (lastError && /HTTP 429|HTTP 503/.test(lastError.message)) await sleep(800 * (attempt + 1));
      }
    }
  }
  throw lastError || new Error("Could not reach Yahoo Finance");
}

async function getQuote(symbol) {
  const key = symbol.toUpperCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return { ...hit.payload, cached: true };
  if (inflight.has(key)) return inflight.get(key);
  const p = fetchYahoo(key)
    .then((payload) => {
      cache.set(key, { ts: Date.now(), payload });
      return payload;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/* ------------------------------------------------------------------ *
 * 3) Routes
 * ------------------------------------------------------------------ */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, uptime: process.uptime(), node: process.version })
);

app.get(
  "/api/diag",
  wrap(async (_req, res) => {
    const diag = {
      node: process.version,
      express: require("express/package.json").version,
      esbuild: (() => {
        try {
          require("esbuild");
          return "installed";
        } catch {
          return "MISSING (run npm install)";
        }
      })(),
      bundle: (() => {
        try {
          getBundle();
          return "OK";
        } catch (e) {
          return "FAILED: " + e.message;
        }
      })(),
      indexHtml: fs.existsSync(INDEX_HTML) ? "public/index.html" : "MISSING (using built-in fallback)",
      stylesCss: fs.existsSync(STYLES_CSS) ? "public/styles.css" : "MISSING (using built-in fallback)",
      globalFetch: typeof fetch === "function" ? "yes" : "no (using node:https)",
    };
    try {
      const q = await getQuote("SPY");
      diag.yahoo = `OK — SPY ${q.price} (${q.closes.length} bars)`;
    } catch (e) {
      diag.yahoo = "FAILED: " + e.message;
    }
    res.json(diag);
  })
);

app.get(
  "/api/quote/:symbol",
  wrap(async (req, res) => {
    const symbol = String(req.params.symbol || "").toUpperCase().trim();
    if (!/^[A-Z0-9.^=]{1,15}$/.test(symbol)) return res.status(400).json({ error: "Invalid symbol" });

    try {
      const data = await getQuote(symbol);
      res.set("Cache-Control", "no-store");
      res.json(data);
    } catch (err) {
      console.error(`[api] ${symbol} failed:`, err.message);
      res.status(502).json({ error: err.message || "Upstream request failed" });
    }
  })
);

// Fresh bundle (rebuilt automatically whenever app.jsx changes)
app.get("/app.js", (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    res.type("application/javascript").send(getBundle());
  } catch (e) {
    next(e);
  }
});

app.use(express.static(PUBLIC_DIR));

// Version-agnostic SPA fallback (Express 4 & 5 safe)
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  if (req.method !== "GET") return next();
  if (fs.existsSync(INDEX_HTML)) return res.sendFile(INDEX_HTML);
  res
    .status(200)
    .type("html")
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Market Sentiment</title>
<link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div>
<script>
window.addEventListener('error',function(e){document.getElementById('root').innerHTML='<pre style="color:#ff8080;padding:20px;font:14px monospace;white-space:pre-wrap">'+e.message+'\\n'+(e.error&&e.error.stack||'')+'</pre>';});
</script>
<script src="/app.js"></script></body></html>`
    );
});

// styles.css fallback
app.get("/styles.css", (req, res) => {
  if (fs.existsSync(STYLES_CSS)) return res.sendFile(STYLES_CSS);
  res.type("text/css").send("body{font-family:system-ui;margin:0;background:#0f1218;color:#e8ecf3;padding:24px}#root{max-width:1000px;margin:auto}");
});

// Error handler -> never crash, always answer
app.use((err, req, res, _next) => {
  console.error("[server] error:", err);
  if (res.headersSent) return;
  if (req.path.startsWith("/api/")) return res.status(500).json({ error: err.message });
  res
    .status(500)
    .type("html")
    .send(
      `<pre style="color:#ff8080;font:14px monospace;white-space:pre-wrap;padding:20px">Server error: ${
        err.message
      }</pre>`
    );
});

process.on("unhandledRejection", (e) => console.error("[server] unhandled rejection:", e));
process.on("uncaughtException", (e) => console.error("[server] uncaught exception:", e));

app.listen(PORT, HOST, () => {
  console.log(`\n  ✅  Market Sentiment running  ->  http://localhost:${PORT}`);
  console.log(`  🔎  Diagnostics             ->  http://localhost:${PORT}/api/diag\n`);
});

