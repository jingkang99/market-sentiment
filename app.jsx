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

/* ---------- cards ---------- */

function Indicator(props) {
  const label = props.label;
  const value = props.value;
  const format = props.format || ((v) => (v == null || v === undefined ? "-" : Number(v).toFixed(2)));
  return (
    <div className="indicator">
      <label>{label}</label>
      <div>{format(value)}</div>
    </div>
  );
}

function StockCard(props) {
  const data = props.data;
  if (!data) return null;
  const a = useMemo(() => analyze(data.bars || []), [data]);
  const sig = useMemo(() => getSignal(contextFrom(data, a)), [data, a]);
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
        <Indicator label="SMA 20" value={a.sma20} />
        <Indicator label="SMA 50" value={a.sma50} />
        <Indicator label="EMA 21" value={a.ema21} />
        <Indicator label="RSI (14)" value={a.rsi} />
        <Indicator label="RSI (21)" value={a.rsi21} />
        <Indicator label="MACD" value={a.macd} format={(v) => (v == null ? "-" : Number(v).toFixed(3))} />
        <Indicator label="ADX (14)" value={a.adx} />
        <Indicator label="BB %B" value={a.pctB} format={(v) => (v == null ? "-" : Number(v).toFixed(0))} />
        <Indicator label="VWAP 20" value={a.vwap} />
      </div>

      <div className={"signal " + sig.label.toLowerCase()}>{sig.label}</div>
      <div style={{ marginTop: 12, fontSize: "0.8rem", color: "var(--muted)" }}>
	{sig.reasons.slice(0, 4).map((r, i) => (<div key={i}>- {r}</div>))}
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

function MarketBreadth({ sectors, watchlist, watchData }) {
  const custom = (watchlist || []).slice(0, 11);
  return (
    <div className="overall breadth">
      <h2>Market Breadth</h2>
      <p className="breadth-sub">Price vs 21-day EMA and 200-day EMA</p>
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

      const sectorFetches = SECTOR_SYMBOLS.map((sym) => fetchYahooChart(sym));
      const watchFetches = list.map((sym) => fetchYahooChart(sym));
      const results = await Promise.allSettled([
        fetchYahooChart("SPY"),
        fetchYahooChart(symbol),
        ...sectorFetches,
        ...watchFetches,
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
    try {
      const data = await fetchYahooChart(sym);
      setSymbol(sym);
      setOther(data);
      try { localStorage.setItem("ms.symbol", sym); } catch (e) {}
      setSymbolInput("");
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setSymbolError(sym + ": " + ((err && err.message) || "failed"));
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
      <span style={{ color: C.sma20 }}><i style={{ background: C.sma20 }} />SMA20</span>
      <span style={{ color: C.sma50 }}><i style={{ background: C.sma50 }} />SMA50</span>
      <span style={{ color: C.ema21 }}><i style={{ background: C.ema21 }} />EMA21</span>
      <span style={{ color: C.rsi }}><i style={{ background: C.rsi }} />RSI14</span>
      <span style={{ color: C.rsi21 }}><i style={{ background: C.rsi21 }} />RSI21</span>
      <span style={{ color: C.macd }}><i style={{ background: C.macd }} />MACD</span>
      <span style={{ color: C.macdSignal }}><i style={{ background: C.macdSignal }} />sig9</span>
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

      {(spy || other) && (
        <div className="overall">
          <h2>Overall Market Bias</h2>
          <div className={"sentiment " + overallLabel.toLowerCase()}>{overallLabel}</div>
          <div className="score">Composite score: {overallScore.toFixed(2)} (SPY + {symbol})</div>
        </div>
      )}

      <MarketBreadth sectors={sectors} watchlist={watchlist} watchData={watchData} />

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
              <span style={{ color: C.sma20 }}><i style={{ background: C.sma20 }} />SMA20</span>
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
              <span style={{ color: C.sma20 }}><i style={{ background: C.sma20 }} />SMA20</span>
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

      <footer>Built with React + Express - technical analysis is not a guarantee of future performance</footer>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);

