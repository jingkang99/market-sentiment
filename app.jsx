// app.jsx  (ASCII-only, no backticks, no smart quotes)
import React, { useState, useEffect, useCallback, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { analyze } from "./indicators.js";
import { PriceChart, COLORS as C } from "./charts.jsx";
import { getSignal, combineSignals, contextFrom } from "./signals.js";

/* ---------- expandable chart card ---------- */

function ChartCard({ id, title, legend, expanded, onToggle, children }) {
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e) => {
      if (e.key === "Escape") onToggle(null);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [expanded, onToggle]);

  return (
    <div className={"chart-card" + (expanded ? " expanded" : "")}>
      <div className="chart-head">
        <div className="chart-title">{title}</div>
        <div className="chart-head-right">
          {legend}
          <button
            type="button"
            className="expand-btn"
            title={expanded ? "Exit full view (Esc)" : "Enlarge chart"}
            aria-label={expanded ? "Exit full view" : "Enlarge chart"}
            onClick={() => onToggle(expanded ? null : id)}
          >
            {expanded ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
              </svg>
            )}
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}

/* ---------- data fetching ---------- */

async function fetchJSON(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Request timed out after " + timeoutMs + "ms", "TimeoutError")), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.text();
        if (body) {
          try {
            const j = JSON.parse(body);
            detail = j.error || j.message || body.slice(0, 120);
          } catch {
            detail = body.slice(0, 120);
          }
        }
      } catch {}
      const msg = "HTTP " + res.status + (res.statusText ? " " + res.statusText : "") + (detail ? " — " + detail : "");
      throw new Error(msg);
    }
    return await res.json();
  } catch (e) {
    if (e && e.name === "AbortError") {
      throw new Error("Request timed out (" + timeoutMs + "ms)");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLocalQuote(symbol) {
  const data = await fetchJSON("/api/quote/" + encodeURIComponent(symbol));
  if (!data || data.error) {
    throw new Error((data && data.error) || ("Local API returned no data for " + symbol));
  }
  if (!Array.isArray(data.closes) || data.closes.length < 50) {
    throw new Error("Local API returned only " + ((data.closes && data.closes.length) || 0) + " closes for " + symbol + " (need 50+)");
  }
  if (!Array.isArray(data.bars) || data.bars.length < 50) {
    data.bars = data.closes.map((c, i) => ({
      t: Date.now() - (data.closes.length - i) * 86400000, o: c, h: c, l: c, c, v: 0,
    }));
  }
  return Object.assign({}, data, { source: data.source || "local api" });
}

const PROXIES = [
  (u) => "https://corsproxy.io/?" + encodeURIComponent(u),
  (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
  (u) => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u),
];

function normalizeChart(result, symbol) {
  const meta = result.meta || {};
  const ts = result.timestamp || [];
  const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close ? q.close[i] : null;
    if (typeof c !== "number" || !Number.isFinite(c)) continue;
    const o = typeof (q.open && q.open[i]) === "number" ? q.open[i] : c;
    const h = typeof (q.high && q.high[i]) === "number" ? q.high[i] : Math.max(o, c);
    const l = typeof (q.low && q.low[i]) === "number" ? q.low[i] : Math.min(o, c);
    bars.push({
      t: ts[i] * 1000, o: o, h: h, l: l, c: c,
      v: typeof (q.volume && q.volume[i]) === "number" ? q.volume[i] : 0,
    });
  }
  if (bars.length < 50) throw new Error("Not enough historical data for " + symbol);
  const closes = bars.map((b) => b.c);
  const price = typeof meta.regularMarketPrice === "number" ? meta.regularMarketPrice : closes[closes.length - 1];
  const previousClose = typeof meta.previousClose === "number" ? meta.previousClose : closes.length >= 2 ? closes[closes.length - 2] : price;
  const change = price - previousClose;
  return {
    symbol: symbol,
    name: meta.shortName || symbol,
    price: price,
    previousClose: previousClose,
    change: change,
    changePercent: previousClose ? (change / previousClose) * 100 : 0,
    closes: closes,
    bars: bars,
    currency: meta.currency || "USD",
    exchange: meta.fullExchangeName || meta.exchangeName || "",
    source: "public proxy",
  };
}

async function fetchViaPublicProxies(symbol) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + symbol + "?interval=1d&range=2y";
  let lastError = null;
  for (const mk of PROXIES) {
    try {
      const raw = await fetchJSON(mk(url), 15000);
      const r = raw && raw.chart && raw.chart.result && raw.chart.result[0];
      if (!r) throw new Error("Proxy returned empty chart for " + symbol);
      return normalizeChart(r, symbol);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("All public CORS proxies failed for " + symbol);
}

async function fetchYahooChart(symbol) {
  try {
    return await fetchLocalQuote(symbol);
  } catch (localErr) {
    console.warn("[" + symbol + "] local API failed (" + localErr.message + ") - trying public proxies");
    return await fetchViaPublicProxies(symbol);
  }
}

/* ---------- CNN Fear & Greed ---------- */

function ratingClass(rating) {
  return String(rating || "neutral")
    .toLowerCase()
    .replace(/\s+/g, "-");
}

/** Shared sparkline used by CNN Fear & Greed and VIX panels */
function SparkLineChart({ points, theme, yMin, yMax, yTicks, rightLabels, ariaLabel }) {
  const w = 520;
  const h = 140;
  const padL = 36;
  const padR = rightLabels && rightLabels.length ? 78 : 14;
  const padT = 14;
  const padB = 22;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  if (!points || points.length < 2) {
    return <div className="fg-loading">Loading chart…</div>;
  }

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min.apply(null, xs);
  const maxX = Math.max.apply(null, xs);
  let minY = yMin != null ? yMin : Math.min.apply(null, ys);
  let maxY = yMax != null ? yMax : Math.max.apply(null, ys);
  if (minY === maxY) {
    minY -= 1;
    maxY += 1;
  }
  // small padding when auto-scaling
  if (yMin == null || yMax == null) {
    const pad = (maxY - minY) * 0.08;
    minY -= pad;
    maxY += pad;
  }

  const xScale = (x) => padL + ((x - minX) / (maxX - minX || 1)) * innerW;
  const yScale = (y) => padT + (1 - (y - minY) / (maxY - minY || 1)) * innerH;

  let d = "";
  for (let i = 0; i < points.length; i++) {
    const px = xScale(points[i].x);
    const py = yScale(points[i].y);
    d += (i === 0 ? "M" : "L") + px.toFixed(1) + "," + py.toFixed(1);
  }

  const monthLabels = [];
  const seenMonth = {};
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const dt = new Date(p.x);
    const key = dt.getFullYear() + "-" + dt.getMonth();
    if (seenMonth[key]) continue;
    seenMonth[key] = true;
    const label =
      dt.toLocaleString("en-US", { month: "short" }) +
      (dt.getMonth() === 0 ? " " + dt.getFullYear() : "");
    monthLabels.push({ x: p.x, label: label });
  }
  const step = Math.max(1, Math.ceil(monthLabels.length / 5));
  const ticks = monthLabels.filter(function (_, i) {
    return i % step === 0 || i === monthLabels.length - 1;
  });

  const tickVals =
    yTicks ||
    (function () {
      const out = [];
      const n = 4;
      for (let i = 0; i <= n; i++) out.push(minY + ((maxY - minY) * i) / n);
      return out;
    })();

  const lineColor = theme === "light" ? "#2563eb" : "#60a5fa";
  const gridColor = theme === "light" ? "rgba(100,116,139,0.25)" : "rgba(148,163,184,0.22)";
  const labelColor = theme === "light" ? "#64748b" : "#8b94a7";

  return (
    <svg viewBox={"0 0 " + w + " " + h} preserveAspectRatio="none" aria-label={ariaLabel || "chart"}>
      {tickVals.map(function (gy, i) {
        return (
          <line
            key={"g" + i}
            x1={padL}
            x2={w - padR}
            y1={yScale(gy)}
            y2={yScale(gy)}
            stroke={gridColor}
            strokeDasharray="3 3"
            strokeWidth="1"
          />
        );
      })}
      {tickVals.map(function (gy, i) {
        const label =
          Math.abs(gy) >= 10 || gy === 0 ? Math.round(gy) : Number(gy).toFixed(1);
        return (
          <text key={"yl" + i} x={padL - 6} y={yScale(gy) + 3} fontSize="9" fill={labelColor} textAnchor="end">
            {label}
          </text>
        );
      })}
      {rightLabels &&
        rightLabels.map(function (rl, i) {
          return (
            <text
              key={"rl" + i}
              x={w - padR + 6}
              y={yScale(rl.y) + 3}
              fontSize="9"
              fill={labelColor}
              textAnchor="start"
            >
              {rl.label}
            </text>
          );
        })}
      <path d={d} fill="none" stroke={lineColor} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {ticks.map(function (t, i) {
        return (
          <text key={"xl" + i} x={xScale(t.x)} y={h - 6} fontSize="9" fill={labelColor} textAnchor="middle">
            {t.label}
          </text>
        );
      })}
    </svg>
  );
}

function FearGreedChart({ points, theme }) {
  return (
    <SparkLineChart
      points={points}
      theme={theme}
      yMin={0}
      yMax={100}
      yTicks={[0, 25, 50, 75, 100]}
      rightLabels={[
        { y: 75, label: "Extreme Greed" },
        { y: 25, label: "Extreme Fear" },
      ]}
      ariaLabel="CNN Fear and Greed last 6 months"
    />
  );
}

function VixChart({ bars, theme }) {
  const sixMonthsAgo = Date.now() - 183 * 24 * 60 * 60 * 1000;
  let points = (bars || [])
    .filter(function (b) {
      return b && typeof b.t === "number" && typeof b.c === "number" && b.t >= sixMonthsAgo;
    })
    .map(function (b) {
      return { x: b.t, y: b.c };
    });
  if (points.length < 10 && bars && bars.length) {
    points = bars.slice(-130).map(function (b) {
      return { x: b.t, y: b.c };
    });
  }
  return (
    <SparkLineChart
      points={points}
      theme={theme}
      yTicks={null}
      ariaLabel="VIX last 6 months"
    />
  );
}

function FearGreedPanel({ data, loading, error, theme }) {
  const current = data && data.fear_and_greed;
  const hist = data && data.fear_and_greed_historical && data.fear_and_greed_historical.data;

  const sixMonthsAgo = Date.now() - 183 * 24 * 60 * 60 * 1000;
  let points = (hist || [])
    .filter(function (p) {
      return typeof p.x === "number" && typeof p.y === "number" && p.x >= sixMonthsAgo;
    })
    .map(function (p) {
      return { x: p.x, y: p.y, rating: p.rating };
    });
  if (points.length < 10) {
    points = (hist || []).slice(-130).map(function (p) {
      return { x: p.x, y: p.y, rating: p.rating };
    });
  }

  const rating = current ? current.rating : null;
  const score = current ? current.score : null;

  // Map CNN rating → same sentiment color classes used on the left
  let sentClass = "neutral";
  const r = String(rating || "").toLowerCase();
  if (r.indexOf("greed") >= 0) sentClass = "bullish";
  else if (r.indexOf("fear") >= 0) sentClass = "bearish";

  return (
    <div className="overall-right">
      <h2>CNN Fear &amp; Greed Index</h2>
      {loading && !current && <div className="fg-loading">Loading…</div>}
      {error && !current && <div className="fg-error">{error}</div>}
      {current && (
        <>
          <div className={"sentiment " + sentClass}>
            {String(rating || "").toUpperCase()}
          </div>
          <div className="score">
            Score: {Number(score).toFixed(1)}
            {current.previous_close != null
              ? " (prev close " + Number(current.previous_close).toFixed(1) + ")"
              : ""}
          </div>
          <div className="fg-chart-wrap">
            <FearGreedChart points={points} theme={theme} />
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- cards ---------- */

function Indicator(props) {
  const label = props.label;
  const value = props.value;
  const tone = props.tone; // "bull" | "bear" | "mixed" | null
  const format = props.format || ((v) => (v == null || v === undefined ? "-" : Number(v).toFixed(2)));
  const toneClass =
    tone === "bull" ? " indicator-bull" : tone === "bear" ? " indicator-bear" : tone === "mixed" ? " indicator-mixed" : "";
  return (
    <div className={"indicator" + toneClass}>
      <label>{label}</label>
      <div>{format(value)}</div>
    </div>
  );
}

/** Map each indicator to bull / bear / mixed using same spirit as Market Breadth tiles */
function indicatorTone(id, a, price) {
  if (price == null || !a) return null;
  switch (id) {
    case "sma20":
      if (a.sma20 == null) return null;
      return price > a.sma20 ? "bull" : price < a.sma20 ? "bear" : "mixed";
    case "sma50":
      if (a.sma50 == null) return null;
      return price > a.sma50 ? "bull" : price < a.sma50 ? "bear" : "mixed";
    case "ema21":
      if (a.ema21 == null) return null;
      return price > a.ema21 ? "bull" : price < a.ema21 ? "bear" : "mixed";
    case "rsi14":
      if (a.rsi == null) return null;
      if (a.rsi > 55) return "bull";
      if (a.rsi < 45) return "bear";
      return "mixed";
    case "rsi21":
      if (a.rsi21 == null) return null;
      if (a.rsi21 > 55) return "bull";
      if (a.rsi21 < 45) return "bear";
      return "mixed";
    case "macd":
      if (a.macd == null) return null;
      return a.macd > 0 ? "bull" : a.macd < 0 ? "bear" : "mixed";
    case "adx":
      if (a.adx == null) return null;
      if (a.adx > 25) {
        if (a.plusDI != null && a.minusDI != null) {
          if (a.plusDI > a.minusDI) return "bull";
          if (a.minusDI > a.plusDI) return "bear";
        }
        return "mixed";
      }
      return "mixed";
    case "pctB":
      if (a.pctB == null) return null;
      // %B: above mid-band (>50) lean bull, below lean bear; extremes still directional
      if (a.pctB > 50) return "bull";
      if (a.pctB < 50) return "bear";
      return "mixed";
    case "vwap":
      if (a.vwap == null) return null;
      return price > a.vwap ? "bull" : price < a.vwap ? "bear" : "mixed";
    default:
      return null;
  }
}

function StockCard(props) {
  const data = props.data;
  if (!data) return null;
  const a = useMemo(() => analyze(data.bars || []), [data]);
  const sig = useMemo(() => getSignal(contextFrom(data, a)), [data, a]);
  const price = data.price;
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="symbol">{data.symbol}</div>
          <div style={{ fontSize: "0.85rem", color: "var(--muted)" }}>
            {data.exchange} <span className="badge">{data.source || "api"}</span>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="price">{"$" + data.price.toFixed(2)}</div>
          <div className={"change " + (data.change >= 0 ? "positive" : "negative")}>
            {data.change >= 0 ? "+" : ""}
            {data.change.toFixed(2)} ({data.changePercent.toFixed(2)}%)
          </div>
        </div>
      </div>

      <div className="indicators">
        <Indicator label="SMA 20" value={a.sma20} tone={indicatorTone("sma20", a, price)} />
        <Indicator label="SMA 50" value={a.sma50} tone={indicatorTone("sma50", a, price)} />
        <Indicator label="EMA 21" value={a.ema21} tone={indicatorTone("ema21", a, price)} />
        <Indicator label="RSI (14)" value={a.rsi} tone={indicatorTone("rsi14", a, price)} />
        <Indicator label="RSI (21)" value={a.rsi21} tone={indicatorTone("rsi21", a, price)} />
        <Indicator
          label="MACD"
          value={a.macd}
          format={(v) => (v == null ? "-" : Number(v).toFixed(3))}
          tone={indicatorTone("macd", a, price)}
        />
        <Indicator label="ADX (14)" value={a.adx} tone={indicatorTone("adx", a, price)} />
        <Indicator
          label="BB %B"
          value={a.pctB}
          format={(v) => (v == null ? "-" : Number(v).toFixed(0))}
          tone={indicatorTone("pctB", a, price)}
        />
        <Indicator label="VWAP 20" value={a.vwap} tone={indicatorTone("vwap", a, price)} />
      </div>

      <div className={"signal " + sig.label.toLowerCase()}>{sig.label}</div>
      <div style={{ marginTop: 12, fontSize: "0.8rem", color: "var(--muted)" }}>
        {sig.reasons.slice(0, 4).map((r, i) => (
          <div key={i}>- {r}</div>
        ))}
      </div>
    </div>
  );
}

/* ---------- market breadth (sector ETFs) ---------- */

const SECTOR_SYMBOLS = ["XLK", "XLF", "XLV", "XLY", "XLP", "XLE", "XLI", "XLB", "XLU", "XLRE", "XLC"];

const SECTOR_NAMES = {
  XLK: "Information Technology",
  XLF: "Financials",
  XLV: "Health Care",
  XLY: "Consumer Discretionary",
  XLP: "Consumer Staples",
  XLE: "Energy",
  XLI: "Industrials",
  XLB: "Materials",
  XLU: "Utilities",
  XLRE: "Real Estate",
  XLC: "Communication Services",
};

function parseBreadthList(text) {
  const out = [];
  const seen = new Set();
  const lines = String(text || "").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim().toUpperCase();
    if (!line) continue;
    // allow comma or space separated on one line
    const parts = line.split(/[\s,;]+/).filter(Boolean);
    for (const p of parts) {
      if (!/^[A-Z0-9.^=]{1,15}$/.test(p)) continue;
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
      if (out.length >= 11) return out;
    }
  }
  return out;
}

async function loadBreadthWatchlist() {
  try {
    const res = await fetch("/breadth-stocks.txt?ts=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    return parseBreadthList(text);
  } catch (e) {
    console.warn("[breadth] could not load breadth-stocks.txt:", e && e.message);
    return [];
  }
}

/* ---------- market indices panel (above Market Breadth) ---------- */

function parseIndexList(text) {
  const out = [];
  const seen = new Set();
  const lines = String(text || "").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim().toUpperCase();
    if (!line) continue;
    const parts = line.split(/[\s,;]+/).filter(Boolean);
    for (const p of parts) {
      // normalize common VIX aliases
      let sym = p;
      if (sym === "VI" || sym === "VIX") sym = "^VIX";
      if (!/^[A-Z0-9.^=]{1,15}$/.test(sym)) continue;
      if (seen.has(sym)) continue;
      seen.add(sym);
      out.push(sym);
      if (out.length >= 220) break;
    }
    if (out.length >= 220) break;
  }
  // First symbol is always VIX
  const vixIdx = out.findIndex((s) => s === "^VIX" || s === "VIX");
  if (vixIdx === -1) {
    out.unshift("^VIX");
  } else if (vixIdx > 0) {
    out.splice(vixIdx, 1);
    out.unshift("^VIX");
  } else {
    out[0] = "^VIX";
  }
  // final dedupe after possible prepend
  const final = [];
  const seen2 = new Set();
  for (const s of out) {
    if (seen2.has(s)) continue;
    seen2.add(s);
    final.push(s);
    if (final.length >= 220) break;
  }
  return final;
}

async function loadIndexWatchlist() {
  try {
    const res = await fetch("/index-stocks.txt?ts=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    return parseIndexList(text);
  } catch (e) {
    console.warn("[indices] could not load index-stocks.txt:", e && e.message);
    return ["^VIX"];
  }
}

function BreadthTile({ data, symbol, tip }) {
  const sym = (data && data.symbol) || symbol;
  const tipText = tip || SECTOR_NAMES[sym] || (data && data.name) || sym;

  if (!data) {
    return (
      <div className="breadth-tile breadth-loading">
        <div className="breadth-sym" data-tip={tipText}>{sym}</div>
        <div className="breadth-price">…</div>
      </div>
    );
  }
  const a = analyze(data.bars || []);
  const price = data.price;
  const above21 = a.ema21 != null && price != null && price > a.ema21;
  const above200 = a.ema200 != null && price != null && price > a.ema200;
  let tone = "mixed";
  if (above21 && above200) tone = "bull";
  else if (!above21 && !above200) tone = "bear";

  return (
    <div className={"breadth-tile breadth-" + tone}>
      <div className="breadth-sym" data-tip={tipText}>{sym}</div>
      <div className="breadth-price">
        {price != null ? "$" + Number(price).toFixed(2) : "—"}
      </div>
      <div className="breadth-flags">
        <span className={above21 ? "flag-up" : "flag-down"}>
          {above21 ? "↑" : "↓"} 21E
        </span>
        <span className={above200 ? "flag-up" : "flag-down"}>
          {above200 ? "↑" : "↓"} 200E
        </span>
      </div>
    </div>
  );
}

function SectionToggle({ open, onToggle, label }) {
  return (
    <button
      type="button"
      className="section-toggle"
      onClick={onToggle}
      title={open ? "Hide " + label : "Show " + label}
      aria-label={open ? "Hide " + label : "Show " + label}
      aria-expanded={open}
    >
      {open ? "−" : "+"}
    </button>
  );
}

function MarketBreadth({ sectors, watchlist, watchData, open, onToggle }) {
  const custom = (watchlist || []).slice(0, 11);
  return (
    <div className={"overall breadth" + (open ? "" : " section-collapsed")}>
      <SectionToggle open={open} onToggle={onToggle} label="Market Breadth" />
      {open ? (
        <>
          <h2>Market Breadth</h2>
          <div className="breadth-grid">
            {SECTOR_SYMBOLS.map((sym) => (
              <BreadthTile key={sym} symbol={sym} data={sectors[sym] || null} tip={SECTOR_NAMES[sym]} />
            ))}
          </div>
          {custom.length > 0 && (
            <div className="breadth-grid breadth-grid-custom">
              {custom.map((sym) => (
                <BreadthTile
                  key={"w-" + sym}
                  symbol={sym}
                  data={(watchData && watchData[sym]) || null}
                  tip={(watchData && watchData[sym] && watchData[sym].name) || sym}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="section-collapsed-label">Market Breadth</div>
      )}
    </div>
  );
}

function vixTone(price) {
  if (price == null || !Number.isFinite(price)) return "loading";
  if (price < 20) return "vix-green";
  if (price < 25) return "vix-blue";
  if (price < 30) return "vix-amber";
  if (price < 50) return "vix-orange";
  return "vix-red";
}

function isVixSymbol(sym) {
  const s = String(sym || "").toUpperCase().replace(/^\^/, "");
  return s === "VIX" || s === "VI";
}

function IndexTile({ data, symbol }) {
  const sym = (data && data.symbol) || symbol;
  const displaySym = isVixSymbol(sym) ? "VIX" : String(sym || "").replace(/^\^/, "");
  const tipText = (data && data.name) || displaySym;

  if (!data) {
    return (
      <div className="breadth-tile breadth-loading">
        <div className="breadth-sym" data-tip={tipText}>{displaySym}</div>
        <div className="breadth-price">…</div>
      </div>
    );
  }

  const a = analyze(data.bars || []);
  const price = data.price;
  const change = data.change;
  const above21 = a.ema21 != null && price != null && price > a.ema21;

  let tone;
  if (isVixSymbol(sym)) {
    tone = vixTone(price);
  } else {
    // same bull/bear/mixed logic as Market Breadth, driven by 21EMA only for visual consistency with the single flag
    tone = above21 ? "bull" : "bear";
  }

  const changeStr =
    change == null || !Number.isFinite(change)
      ? "—"
      : (change >= 0 ? "+" : "") + Number(change).toFixed(2);

  return (
    <div className={"breadth-tile breadth-" + tone}>
      <div className="breadth-sym" data-tip={tipText}>{displaySym}</div>
      <div className="breadth-price">
        {price != null ? Number(price).toFixed(2) : "—"}
      </div>
      <div className={"breadth-change " + (change >= 0 ? "positive" : "negative")}>
        {changeStr}
      </div>
      <div className="breadth-flags">
        <span className={above21 ? "flag-up" : "flag-down"}>
          {above21 ? "↑" : "↓"} 21E
        </span>
      </div>
    </div>
  );
}

function MarketIndices({ symbols, data, open, onToggle }) {
  const list = symbols || [];
  if (list.length === 0 && open) return null;
  const rows = [];
  for (let i = 0; i < list.length; i += 11) {
    rows.push(list.slice(i, i + 11));
  }
  return (
    <div className={"overall indices" + (open ? "" : " section-collapsed")}>
      <SectionToggle open={open} onToggle={onToggle} label="Market Indices" />
      {open ? (
        <>
          <h2>Market Indices</h2>
          {rows.map((row, ri) => (
            <div className="indices-grid" key={"idx-row-" + ri}>
              {row.map((sym) => (
                <IndexTile
                  key={"idx-" + sym}
                  symbol={sym}
                  data={(data && data[sym]) || null}
                />
              ))}
            </div>
          ))}
        </>
      ) : (
        <div className="section-collapsed-label">Market Indices</div>
      )}
    </div>
  );
}

/* ---------- app ---------- */

const SYMBOL_RE = /^[A-Z0-9.^=]{1,15}$/;

function App() {
  const [spy, setSpy] = useState(null);
  const [other, setOther] = useState(null);
  const [sectors, setSectors] = useState({});
  const [watchlist, setWatchlist] = useState([]);
  const [watchData, setWatchData] = useState({});
  const [indexList, setIndexList] = useState([]);
  const [indexData, setIndexData] = useState({});
  const [fgData, setFgData] = useState(null);
  const [fgLoading, setFgLoading] = useState(false);
  const [fgError, setFgError] = useState(null);
  const [showOverall, setShowOverall] = useState(true);
  const [showIndices, setShowIndices] = useState(true);
  const [showBreadth, setShowBreadth] = useState(true);
  const [symbol, setSymbol] = useState(() => {
    try { return localStorage.getItem("ms.symbol") || "QQQ"; } catch (e) { return "QQQ"; }
  });
  const [symbolInput, setSymbolInput] = useState("");
  const [symbolError, setSymbolError] = useState(null);
  const [symbolLoading, setSymbolLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [months, setMonths] = useState(6);
  const [expandedChart, setExpandedChart] = useState(null);
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem("ms.theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch (e) {}
    return "dark";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("ms.theme", theme); } catch (e) {}
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  const expandHeight = useMemo(() => {
    if (typeof window === "undefined") return 640;
    return Math.max(420, window.innerHeight - 72);
  }, [expandedChart]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await loadBreadthWatchlist();
      setWatchlist(list);
      const idxList = await loadIndexWatchlist();
      setIndexList(idxList);

      const sectorFetches = SECTOR_SYMBOLS.map((sym) => fetchYahooChart(sym));
      const watchFetches = list.map((sym) => fetchYahooChart(sym));
      const indexFetches = idxList.map((sym) => fetchYahooChart(sym));
      const results = await Promise.allSettled([
        fetchYahooChart("SPY"),
        fetchYahooChart(symbol),
        ...sectorFetches,
        ...watchFetches,
        ...indexFetches,
      ]);
      const s = results[0];
      const o = results[1];
      let hasData = false;
      const errs = [];
      if (s.status === "fulfilled") { setSpy(s.value); hasData = true; }
      else { console.error("SPY failed:", s.reason); errs.push("SPY: " + ((s.reason && s.reason.message) || "failed")); }
      if (o.status === "fulfilled") { setOther(o.value); hasData = true; }
      else { console.error(symbol + " failed:", o.reason); errs.push(symbol + ": " + ((o.reason && o.reason.message) || "failed")); setOther(null); }

      const nextSectors = {};
      SECTOR_SYMBOLS.forEach((sym, i) => {
        const r = results[2 + i];
        if (r && r.status === "fulfilled") {
          nextSectors[sym] = r.value;
          hasData = true;
        } else {
          console.error(sym + " failed:", r && r.reason);
        }
      });
      setSectors(nextSectors);

      const nextWatch = {};
      const watchOffset = 2 + SECTOR_SYMBOLS.length;
      list.forEach((sym, i) => {
        const r = results[watchOffset + i];
        if (r && r.status === "fulfilled") {
          nextWatch[sym] = r.value;
          hasData = true;
        } else {
          console.error(sym + " failed:", r && r.reason);
        }
      });
      setWatchData(nextWatch);

      const nextIndex = {};
      const indexOffset = watchOffset + list.length;
      idxList.forEach((sym, i) => {
        const r = results[indexOffset + i];
        if (r && r.status === "fulfilled") {
          nextIndex[sym] = r.value;
          hasData = true;
        } else {
          console.error(sym + " failed:", r && r.reason);
        }
      });
      setIndexData(nextIndex);

      // CNN Fear & Greed (best-effort; does not block main market data)
      setFgLoading(true);
      setFgError(null);
      try {
        const fgRes = await fetchJSON("/api/fear-greed", 12000);
        setFgData(fgRes);
      } catch (fgErr) {
        console.warn("[fear-greed]", fgErr && fgErr.message);
        setFgError((fgErr && fgErr.message) || "Fear & Greed unavailable");
      } finally {
        setFgLoading(false);
      }

      if (hasData) setLastUpdated(new Date());
      if (errs.length) setError(errs.join(" | ") + (hasData ? " (partial data shown)" : " - is the local server running? Try: npm start"));
    } catch (e) {
      console.error(e);
      setError((e && e.message) || "Failed to load market data.");
    } finally { setLoading(false); }
  }, [symbol]);

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(loadData, 60000);
    return () => clearInterval(id);
  }, [autoRefresh, loadData]);

  const onSubmitSymbol = async (e) => {
    e.preventDefault();
    const sym = String(symbolInput || "").trim().toUpperCase().replace(/\s+/g, "");
    if (!SYMBOL_RE.test(sym)) { setSymbolError("Enter a ticker like AAPL, MSFT, BRK-B"); return; }
    if (sym === "SPY") { setSymbolError("SPY is already shown on the left - pick another symbol."); return; }
    setSymbolLoading(true);
    setSymbolError(null);
    const SYMBOL_TIMEOUT_MS = 7000;
    try {
      // Cap wait at 7s so invalid / missing symbols fail quickly
      const data = await Promise.race([
        fetchYahooChart(sym),
        new Promise(function (_, reject) {
          setTimeout(function () {
            reject(new Error("Request timed out after " + SYMBOL_TIMEOUT_MS / 1000 + "s — symbol may not exist"));
          }, SYMBOL_TIMEOUT_MS);
        }),
      ]);
      setSymbol(sym);
      setOther(data);
      try { localStorage.setItem("ms.symbol", sym); } catch (e) {}
      setSymbolInput("");
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setSymbolError(sym + ": " + ((err && err.message) || "failed"));
      // Auto-clear error message after 2 seconds
      setTimeout(function () {
        setSymbolError(null);
      }, 2000);
    } finally { setSymbolLoading(false); }
  };

  const resetSymbol = () => { setSymbol("QQQ"); setSymbolInput(""); setSymbolError(null); try { localStorage.removeItem("ms.symbol"); } catch (e) {} };

  const spyA = useMemo(() => (spy ? analyze(spy.bars || []) : null), [spy]);
  const otherA = useMemo(() => (other ? analyze(other.bars || []) : null), [other]);

  let overallLabel = "NEUTRAL";
  let overallScore = 0;
  if (spy && other && spyA && otherA) {
    const s1 = getSignal(contextFrom(spy, spyA));
    const s2 = getSignal(contextFrom(other, otherA));
    const overall = combineSignals([s1, s2]);
    overallScore = overall.score;
    overallLabel = overall.label;
  }

  const mL = months === 12 ? "12" : String(months);

  const legend = (extra) => (
    <div className="chart-legend">
      <span style={{ color: C.sma10 }}><i style={{ background: C.sma10 }} />SMA10</span>
      <span style={{ color: C.sma50 }}><i style={{ background: C.sma50 }} />SMA50</span>
      <span style={{ color: C.ema21 }}><i style={{ background: C.ema21 }} />EMA21</span>
      <span style={{ color: C.rsi }}><i style={{ background: C.rsi }} />RSI14</span>
      <span style={{ color: C.rsi21 }}><i style={{ background: C.rsi21 }} />RSI21</span>
      <span style={{ color: C.macd }}><i style={{ background: C.macd }} />MACD</span>
      <span style={{ color: C.macdSignal }}><i style={{ background: C.macdSignal }} />sig9</span>
      <span style={{ color: C.adx }}><i style={{ background: C.adx }} />ADX</span>
      <span style={{ color: C.plusDI }}><i style={{ background: C.plusDI }} />+DI</span>
      <span style={{ color: C.minusDI }}><i style={{ background: C.minusDI }} />-DI</span>
    </div>
  );

  return (
    <div className="container">
      <header>
        <div className="header-text">
          <h1>SPY &amp; Market Sentiment</h1>
          <p>Real-time quotes, technical indicators, candlestick + Bollinger / VWAP charts</p>
        </div>
        <button type="button" className="theme-toggle" onClick={toggleTheme} title="Switch theme">
          <span className="theme-icon" aria-hidden="true">
            {theme === "dark" ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </span>
          <span className="theme-label">{theme === "dark" ? "Light" : "Dark"}</span>
        </button>
      </header>

      <div className="controls">
        <button onClick={loadData} disabled={loading}>{loading ? "Loading..." : "Refresh Data"}</button>
        <form className="symbol-form" onSubmit={onSubmitSymbol}>
          <label className="symbol-label" htmlFor="sym-input">Second symbol</label>
          <input
            id="sym-input"
            className="symbol-input"
            placeholder="e.g. AAPL"
            value={symbolInput}
            onChange={(e) => { setSymbolInput(e.target.value); setSymbolError(null); }}
            list="symbol-list"
            autoComplete="off"
            spellCheck={false}
            maxLength={15}
          />
          <datalist id="symbol-list">
            {["QQQ", "AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META", "AMD", "NFLX", "COIN", "GLD", "IWM", "BRK-B"].map((t) => (<option key={t} value={t} />))}
          </datalist>
          <button type="submit" disabled={symbolLoading}>{symbolLoading ? "Loading..." : "Load"}</button>
          {symbol !== "QQQ" && (<button type="button" className="ghost" onClick={resetSymbol}>Reset to QQQ</button>)}
        </form>
        <label className="toggle">
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          Auto-refresh 60s
        </label>
        <div className="range-tabs">
          {[3, 6, 12].map((m) => (
            <button key={m} className={"tab" + (months === m ? " active" : "")} onClick={() => setMonths(m)}>{m === 12 ? "1Y" : m + "M"}</button>
          ))}
        </div>
      </div>

      {symbolError && <div className="error symbol-error">{symbolError}</div>}
      {error && <div className="error">{error}</div>}
      {lastUpdated && <div className="status">Last updated: {lastUpdated.toLocaleString()}</div>}

      {(spy || other || fgData || fgLoading || !showOverall) && (
        <div className={"overall overall-split" + (showOverall ? "" : " section-collapsed")}>
          <SectionToggle
            open={showOverall}
            onToggle={() => setShowOverall((v) => !v)}
            label="Overall Market Bias"
          />
          {showOverall ? (
            <>
              <div className="overall-left">
                <h2>Overall Market Bias</h2>
                <div className={"sentiment " + overallLabel.toLowerCase()}>{overallLabel}</div>
                <div className="score">
                  Composite score: {overallScore.toFixed(2)} (SPY + {symbol})
                </div>
                <div className="fg-chart-wrap">
                  <VixChart
                    bars={
                      (indexData && indexData["^VIX"] && indexData["^VIX"].bars) ||
                      (indexData && indexData["VIX"] && indexData["VIX"].bars) ||
                      []
                    }
                    theme={theme}
                  />
                </div>
              </div>
              <FearGreedPanel data={fgData} loading={fgLoading} error={fgError} theme={theme} />
            </>
          ) : (
            <div className="section-collapsed-label">Overall Market Bias / Fear &amp; Greed</div>
          )}
        </div>
      )}

      <MarketIndices
        symbols={indexList}
        data={indexData}
        open={showIndices}
        onToggle={() => setShowIndices((v) => !v)}
      />

      <MarketBreadth
        sectors={sectors}
        watchlist={watchlist}
        watchData={watchData}
        open={showBreadth}
        onToggle={() => setShowBreadth((v) => !v)}
      />

      <div className="cards">
        <StockCard data={spy} />
        <StockCard data={other} />
      </div>

      <div className="charts">
        <ChartCard
          id="spy-candles"
          title={"SPY - " + mL + " month candlesticks"}
          legend={legend()}
          expanded={expandedChart === "spy-candles"}
          onToggle={setExpandedChart}
        >
          {spyA ? (
            <PriceChart
              bars={spyA.enriched}
              months={months}
              height={expandedChart === "spy-candles" ? expandHeight : 470}
              theme={theme}
            />
          ) : (
            <div className="skeleton">Loading chart...</div>
          )}
        </ChartCard>

        <ChartCard
          id="other-candles"
          title={(other ? other.symbol : symbol) + " - " + mL + " month candlesticks"}
          legend={legend()}
          expanded={expandedChart === "other-candles"}
          onToggle={setExpandedChart}
        >
          {otherA ? (
            <PriceChart
              bars={otherA.enriched}
              months={months}
              height={expandedChart === "other-candles" ? expandHeight : 470}
              theme={theme}
            />
          ) : (
            <div className="skeleton">Loading chart...</div>
          )}
        </ChartCard>
      </div>

      <h2 className="section-title">Bollinger Bands (20, 2 sigma) and Volume-Weighted VWAP</h2>
      <div className="charts">
        <ChartCard
          id="spy-bands"
          title={"SPY - BB(20,2 sigma) + VWAP(20)"}
          legend={(
            <div className="chart-legend">
              <span style={{ color: C.bb }}><i style={{ background: C.bb }} />BB 20/2s</span>
              <span style={{ color: C.vwap }}><i style={{ background: C.vwap }} />VWAP 20</span>
              <span style={{ color: C.ema21 }}><i style={{ background: C.ema21 }} />EMA21</span>
              <span style={{ color: C.sma10 }}><i style={{ background: C.sma10 }} />SMA10</span>
            </div>
          )}
          expanded={expandedChart === "spy-bands"}
          onToggle={setExpandedChart}
        >
          {spyA ? (
            <PriceChart
              bars={spyA.enriched}
              months={months}
              variant="bands"
              height={expandedChart === "spy-bands" ? expandHeight : 330}
              theme={theme}
            />
          ) : (
            <div className="skeleton">Loading...</div>
          )}
        </ChartCard>

        <ChartCard
          id="other-bands"
          title={(other ? other.symbol : symbol) + " - BB(20,2 sigma) + VWAP(20)"}
          legend={(
            <div className="chart-legend">
              <span style={{ color: C.bb }}><i style={{ background: C.bb }} />BB 20/2s</span>
              <span style={{ color: C.vwap }}><i style={{ background: C.vwap }} />VWAP 20</span>
              <span style={{ color: C.ema21 }}><i style={{ background: C.ema21 }} />EMA21</span>
              <span style={{ color: C.sma10 }}><i style={{ background: C.sma10 }} />SMA10</span>
            </div>
          )}
          expanded={expandedChart === "other-bands"}
          onToggle={setExpandedChart}
        >
          {otherA ? (
            <PriceChart
              bars={otherA.enriched}
              months={months}
              variant="bands"
              height={expandedChart === "other-bands" ? expandHeight : 330}
              theme={theme}
            />
          ) : (
            <div className="skeleton">Loading...</div>
          )}
        </ChartCard>
      </div>

    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);

