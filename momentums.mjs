#!/usr/bin/env node
// momentums.mjs v2.0
// ZERO dependencies — Node.js 18+ only - Powered by AI, Minimax M3
//
// Usage:
//   node momentums.mjs                           -> SPY QQQ (default, daily)
//   node momentums.mjs SPY QQQ IWM TLH           -> custom symbols
//   node momentums.mjs --interval=1h SPY         -> intraday 1-hour
//   node momentums.mjs --interval=15m QQQ        -> intraday 15-min
//   node momentums.mjs --test                    -> run built-in tests
//   node momentums.mjs --no-holidays SPY         -> disable holiday filtering

/* ================= RAW ANSI ESCAPE CODES ================= */
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';
const RED    = '\x1b[31m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE   = '\x1b[34m';
const MAGENTA= '\x1b[35m';
const CYAN   = '\x1b[36m';

const bull = (s) => GREEN + s + RESET;
const bear = (s) => RED + s + RESET;
const neu  = (s) => YELLOW + s + RESET;
const bold = (s) => BOLD + s + RESET;
const dim  = (s) => DIM + s + RESET;
const cyan = (s) => CYAN + s + RESET;
const magenta = (s) => MAGENTA + s + RESET;
const verdictColor = (v) => (v.includes('BULL') ? bull : v.includes('BEAR') ? bear : neu);

/* ================= US MARKET HOLIDAYS (NYSE/NASDAQ) ================= */
const US_MARKET_HOLIDAYS = new Set([
  // 2020
  '2020-01-01', '2020-01-20', '2020-02-17', '2020-04-10', '2020-05-25',
  '2020-07-03', '2020-09-07', '2020-11-26', '2020-12-25',
  // 2021
  '2021-01-01', '2021-01-18', '2021-02-15', '2021-04-02', '2021-05-31',
  '2021-07-05', '2021-09-06', '2021-11-25', '2021-12-24',
  // 2022
  '2022-01-17', '2022-02-21', '2022-04-15', '2022-05-30', '2022-06-20',
  '2022-07-04', '2022-09-05', '2022-11-24', '2022-12-26',
  // 2023
  '2023-01-02', '2023-01-16', '2023-02-20', '2023-04-07', '2023-05-29',
  '2023-06-19', '2023-07-04', '2023-09-04', '2023-11-23', '2023-12-25',
  // 2024
  '2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29', '2024-05-27',
  '2024-06-19', '2024-07-04', '2024-09-02', '2024-11-28', '2024-12-25',
  // 2025
  '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18',
  '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
]);

function toDateStr(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function isWeekend(date) {
  const d = new Date(date);
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

function isUSMarketHoliday(date) {
  return US_MARKET_HOLIDAYS.has(toDateStr(date));
}

function isTradingDay(date, useHolidays = true) {
  if (isWeekend(date)) return false;
  if (useHolidays && isUSMarketHoliday(date)) return false;
  return true;
}

function getPreviousTradingClose(candles, currentIndex, useHolidays = true) {
  for (let i = currentIndex - 1; i >= 0; i--) {
    const candleDate = new Date(candles[i].t * 1000);
    if (isTradingDay(candleDate, useHolidays) && candles[i].c != null) {
      return candles[i].c;
    }
  }
  return null;
}

/* ================= DATA FETCHING ================= */
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

const INTERVAL_CONFIG = {
  '1m':  { range: '1d',  label: '1 min'  },
  '5m':  { range: '5d',  label: '5 min'  },
  '15m': { range: '5d',  label: '15 min' },
  '30m': { range: '1mo', label: '30 min' },
  '1h':  { range: '3mo', label: '1 hour' },
  '1d':  { range: '1y',  label: 'Daily'  },
  '1wk': { range: '5y',  label: 'Weekly' },
  '1mo': { range: '10y', label: 'Monthly'},
};

async function fetchChart(symbol, interval = '1d') {
  const cfg = INTERVAL_CONFIG[interval] || INTERVAL_CONFIG['1d'];
  let lastErr;
  for (const host of HOSTS) {
    try {
      const res = await fetch(
        `${host}/v8/finance/chart/${symbol}?interval=${interval}&range=${cfg.range}&includePrePost=false`,
        { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json?.chart?.error) throw new Error(json.chart.error.description);
      const r = json.chart.result[0];
      const q = r.indicators.quote[0];
      const candles = r.timestamp
        .map((t, i) => ({ t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] }))
        .filter((x) => x.c != null);
      return { meta: r.meta, candles, interval };
    } catch (e) {
      lastErr = e;
      await new Promise((r2) => setTimeout(r2, 300));
    }
  }
  throw lastErr;
}

/* ================= INDICATOR MATH ================= */
const sma = (v, p) => {
  const out = new Array(v.length).fill(null);
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i];
    if (i >= p) s -= v[i - p];
    if (i >= p - 1) out[i] = s / p;
  }
  return out;
};

const ema = (v, p) => {
  const out = new Array(v.length).fill(null);
  if (v.length < p) return out;
  const k = 2 / (p + 1);
  let prev = 0;
  for (let i = 0; i < p; i++) prev += v[i];
  prev /= p;
  out[p - 1] = prev;
  for (let i = p; i < v.length; i++) {
    prev = v[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
};

const rsi = (v, p = 14) => {
  const out = new Array(v.length).fill(null);
  if (v.length <= p) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const d = v[i] - v[i - 1];
    if (d >= 0) g += d;
    else l -= d;
  }
  g /= p; l /= p;
  out[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    g = (g * (p - 1) + Math.max(d, 0)) / p;
    l = (l * (p - 1) + Math.max(-d, 0)) / p;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
};

const macdCalc = (v, f = 12, s = 26, sg = 9) => {
  const fe = ema(v, f), se = ema(v, s);
  const line = v.map((_, i) => (fe[i] != null && se[i] != null) ? fe[i] - se[i] : null);
  const signal = new Array(v.length).fill(null);
  const hist = new Array(v.length).fill(null);
  const first = line.findIndex((x) => x !== null);
  if (first !== -1) {
    const s2 = ema(line.slice(first), sg);
    for (let i = 0; i < s2.length; i++) {
      if (s2[i] != null) {
        signal[first + i] = s2[i];
        hist[first + i] = line[first + i] - s2[i];
      }
    }
  }
  return { line, signal, hist };
};

const bollinger = (v, p = 20, m = 2) => {
  const mid = sma(v, p);
  const pctB = new Array(v.length).fill(null);
  for (let i = p - 1; i < v.length; i++) {
    let va = 0;
    for (let j = i - p + 1; j <= i; j++) va += (v[j] - mid[i]) ** 2;
    const sd = Math.sqrt(va / p);
    const rng = 2 * m * sd;
    pctB[i] = rng === 0 ? 0.5 : (v[i] - (mid[i] - m * sd)) / rng;
  }
  return pctB;
};

const smoothN = (a, p) => {
  const out = new Array(a.length).fill(null);
  for (let i = 0; i < a.length; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - p + 1); j <= i; j++) {
      if (a[j] != null) { s += a[j]; c++; }
    }
    if (c > 0 && c >= Math.min(p, i + 1)) out[i] = s / c;
  }
  return out;
};

const stochastic = (h, l, c) => {
  const raw = new Array(c.length).fill(null);
  for (let i = 13; i < c.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - 13; j <= i; j++) {
      if (h[j] > hh) hh = h[j];
      if (l[j] < ll) ll = l[j];
    }
    raw[i] = hh === ll ? 50 : ((c[i] - ll) / (hh - ll)) * 100;
  }
  const k = smoothN(raw, 3);
  const d = smoothN(k, 3);
  return { k, d };
};

const adxCalc = (h, l, c, p = 14) => {
  const n = c.length;
  const tr = new Array(n).fill(null);
  const pdm = new Array(n).fill(null);
  const mdm = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
    pdm[i] = up > dn && up > 0 ? up : 0;
    mdm[i] = dn > up && dn > 0 ? dn : 0;
    tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  }
  const aS = new Array(n).fill(null);
  const pS = new Array(n).fill(null);
  const mS = new Array(n).fill(null);
  if (n <= p * 2) return null;
  let A = 0, P = 0, M = 0;
  for (let i = 1; i <= p; i++) { A += tr[i]; P += pdm[i]; M += mdm[i]; }
  aS[p] = A; pS[p] = P; mS[p] = M;
  for (let i = p + 1; i < n; i++) {
    aS[i] = aS[i - 1] - aS[i - 1] / p + tr[i];
    pS[i] = pS[i - 1] - pS[i - 1] / p + pdm[i];
    mS[i] = mS[i - 1] - mS[i - 1] / p + mdm[i];
  }
  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  const dx = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (aS[i] != null && aS[i] > 0) {
      plusDI[i] = (pS[i] / aS[i]) * 100;
      minusDI[i] = (mS[i] / aS[i]) * 100;
      const sum = plusDI[i] + minusDI[i];
      dx[i] = sum === 0 ? 0 : (Math.abs(plusDI[i] - minusDI[i]) / sum) * 100;
    }
  }
  const adxA = new Array(n).fill(null);
  let seed = 0, cnt = 0, seedIdx = -1;
  for (let i = 0; i < n; i++) {
    if (dx[i] == null) continue;
    seed += dx[i]; cnt++;
    if (cnt === p) { adxA[i] = seed / p; seedIdx = i; break; }
  }
  if (seedIdx !== -1) {
    for (let i = seedIdx + 1; i < n; i++) {
      adxA[i] = (adxA[i - 1] * (p - 1) + dx[i]) / p;
    }
  }
  return { adx: adxA, plusDI, minusDI };
};

/* ================= SCORING ================= */
function verdictFor(score) {
  if (score >= 45) return 'STRONG BULLISH';
  if (score >= 12) return 'BULLISH';
  if (score > -12) return 'NEUTRAL';
  if (score > -45) return 'BEARISH';
  return 'STRONG BEARISH';
}

const scoreColor = (s) => (s >= 12 ? bull : s <= -12 ? bear : neu);

/* Adaptive indicator params based on interval */
function getIndicatorParams(interval) {
  const params = {
    '1m':  { sma: [5, 10, 20],  ema: [5, 10],   rsi: 14, bb: 20, stoch: 14, adx: 14, macd: [12, 26, 9] },
    '5m':  { sma: [5, 10, 20],  ema: [5, 10],   rsi: 14, bb: 20, stoch: 14, adx: 14, macd: [12, 26, 9] },
    '15m': { sma: [10, 20, 50], ema: [12, 26],  rsi: 14, bb: 20, stoch: 14, adx: 14, macd: [12, 26, 9] },
    '30m': { sma: [10, 20, 50], ema: [12, 26],  rsi: 14, bb: 20, stoch: 14, adx: 14, macd: [12, 26, 9] },
    '1h':  { sma: [20, 50, 100],ema: [12, 26],  rsi: 14, bb: 20, stoch: 14, adx: 14, macd: [12, 26, 9] },
    '1d':  { sma: [20, 50, 200],ema: [12, 26],  rsi: 14, bb: 20, stoch: 14, adx: 14, macd: [12, 26, 9] },
    '1wk': { sma: [10, 20, 40], ema: [12, 26],  rsi: 14, bb: 20, stoch: 14, adx: 14, macd: [12, 26, 9] },
    '1mo': { sma: [6, 12, 24],  ema: [12, 26],  rsi: 14, bb: 20, stoch: 14, adx: 14, macd: [12, 26, 9] },
  };
  return params[interval] || params['1d'];
}

function analyze(symbol, candles, meta, options = {}) {
  const { interval = '1d', useHolidays = true } = options;

  const close = candles.map((c) => c.c);
  const high  = candles.map((c) => c.h);
  const low   = candles.map((c) => c.l);
  const n = close.length;
  const i = n - 1;
  const price = close[i];
  const params = getIndicatorParams(interval);

  const S20  = sma(close, params.sma[0]);
  const S50  = sma(close, params.sma[1]);
  const S200 = sma(close, params.sma[2]);
  const E12  = ema(close, params.ema[0]);
  const E26  = ema(close, params.ema[1]);
  const R    = rsi(close, params.rsi);
  const M    = macdCalc(close, ...params.macd);
  const B    = bollinger(close, params.bb);
  const ST   = stochastic(high, low, close);
  const X    = adxCalc(high, low, close, params.adx);

  const sig = [];
  const add = (name, dir, w, note) => sig.push({ name, dir, w, note });

  if (S50[i] != null)
    add(`Price vs SMA ${params.sma[1]}`, price > S50[i] ? 1 : -1, 1.2, `${price.toFixed(2)} vs ${S50[i].toFixed(2)}`);
  if (S200[i] != null)
    add(`Price vs SMA ${params.sma[2]}`, price > S200[i] ? 1 : -1, 1.6, `${price.toFixed(2)} vs ${S200[i].toFixed(2)}`);
  if (S50[i] != null && S200[i] != null)
    add(`SMA ${params.sma[1]} vs SMA ${params.sma[2]}`,
      S50[i] > S200[i] ? 1 : -1, 1.4,
      S50[i] > S200[i] ? 'golden regime' : 'death regime');

  // Slope check only for daily/weekly
  if (interval === '1d' || interval === '1wk') {
    if (S20[i] != null && S20[i - 5] != null && Math.abs(S20[i] - S20[i - 5]) / S20[i - 5] >= 0.002)
      add(`SMA ${params.sma[0]} slope (5d)`,
        S20[i] > S20[i - 5] ? 1 : -1, 0.8,
        S20[i] > S20[i - 5] ? 'rising' : 'falling');
  }

  if (E12[i] != null && E26[i] != null)
    add(`EMA ${params.ema[0]} vs EMA ${params.ema[1]}`, E12[i] > E26[i] ? 1 : -1, 1.0, 'momentum');
  if (R[i] != null)
    add(`RSI ${params.rsi}`, R[i] > 55 ? 1 : R[i] < 45 ? -1 : 0, 1.3, R[i].toFixed(1));
  if (ST.k[i] != null && ST.d[i] != null)
    add('Stochastic %K/%D', ST.k[i] > ST.d[i] ? 1 : -1, 0.8, `K ${ST.k[i].toFixed(0)} D ${ST.d[i].toFixed(0)}`);
  if (M.line[i] != null && M.signal[i] != null) {
    add('MACD vs signal', M.line[i] > M.signal[i] ? 1 : -1, 1.3, '');
    add('MACD histogram', M.hist[i] > 0 ? 1 : -1, 0.7, '');
    add('MACD vs zero', M.line[i] > 0 ? 1 : -1, 0.6, M.line[i].toFixed(2));
  }
  if (X && X.adx[i] != null) {
    const strong = X.adx[i] >= 20;
    add('ADX / +DI -DI',
      !strong ? 0 : X.plusDI[i] > X.minusDI[i] ? 1 : -1,
      1.2,
      `ADX ${X.adx[i].toFixed(0)}${!strong ? ' (weak trend)' : ''}`);
  }
  if (B[i] != null)
    add('Bollinger %B', B[i] > 0.55 ? 1 : B[i] < 0.45 ? -1 : 0, 0.8, `${(B[i] * 100).toFixed(0)}%`);

  // 52-week high/low only for daily
  if (interval === '1d' || interval === '1wk') {
    const yh = meta.fiftyTwoWeekHigh, yl = meta.fiftyTwoWeekLow;
    if (yh && yl) {
      const pos = ((price - yl) / (yh - yl)) * 100;
      add('52-week position', pos >= 85 ? 1 : pos <= 25 ? -1 : 0, 0.6, `${pos.toFixed(0)}%`);
    }
  }

  const tw = sig.reduce((a, s) => a + s.w, 0) || 1;
  const raw = sig.reduce((a, s) => a + s.w * s.dir, 0);
  const score = Math.max(-100, Math.min(100, (raw / tw) * 100));
  const verdict = verdictFor(score);

  /* =================== DATE FORMATTING =================== */
  const lastDateRaw = new Date(candles[n - 1].t * 1000);
  const dateOptions = interval === '1d' || interval === '1wk' || interval === '1mo'
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  const lastDate = lastDateRaw.toLocaleDateString('en-US', dateOptions);
  const intervalLabel = INTERVAL_CONFIG[interval]?.label || interval;

  /* =================== PRICE CHANGE (FIXED) =================== */
  const mp = meta.regularMarketPrice ?? price;
  const lastCandleDate = new Date(candles[n - 1].t * 1000);
  const lastIsWeekend = isWeekend(lastCandleDate);
  const lastIsHoliday = isUSMarketHoliday(lastCandleDate);

  let pc;
  let changeNote = '';

  if (meta.previousClose && meta.previousClose > 0) {
    pc = meta.previousClose;
    changeNote = '';
  } else {
    pc = getPreviousTradingClose(candles, n - 1, useHolidays);
    if (lastIsWeekend)      changeNote = ' (weekend)';
    else if (lastIsHoliday) changeNote = ' (holiday)';
    else if (!pc)           changeNote = ' (no prev data)';
  }

  const chgPct = pc ? ((mp - pc) / pc) * 100 : 0;
  const chgStr = `${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%`;

  /* ---------- COLORIZED OUTPUT ---------- */
  console.log(`\n${cyan(bold(`=== ${symbol}  (${lastDate}) [${intervalLabel}] ===`))}`);
  console.log(`Price ${bold(mp.toFixed(2))}  ${chgPct >= 0 ? bull(chgStr) : bear(chgStr)} vs prev close ${pc ? pc.toFixed(2) : '—'}${dim(changeNote)}`);
  const bCnt = sig.filter((s) => s.dir === 1).length;
  const rCnt = sig.filter((s) => s.dir === -1).length;
  const nCnt = sig.filter((s) => s.dir === 0).length;
  console.log(`SCORE: ${scoreColor(score)(`${score >= 0 ? '+' : ''}${score.toFixed(1)}`)}  ->  ${bold(verdictColor(verdict)(verdict))}`);
  console.log(`${bull(`Bull ${bCnt}`)} | ${bear(`Bear ${rCnt}`)} | ${neu(`Neutral ${nCnt}`)}\n`);
  for (const s of sig) {
    const tag = s.dir === 1 ? bull('▲ BULL    ') : s.dir === -1 ? bear('▼ BEAR    ') : neu('■ NEUTRAL ');
    console.log(`  ${tag} ${s.name.padEnd(22)} ${s.note}`);
  }
  return score;
}

/* ================= ARGUMENT PARSING ================= */
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    symbols: ['SPY', 'QQQ'],
    interval: '1d',
    useHolidays: true,
    test: false,
    showHelp: false,
  };

  for (const arg of args) {
    if (arg === '--test') opts.test = true;
    else if (arg === '--help' || arg === '-h') opts.showHelp = true;
    else if (arg === '--no-holidays') opts.useHolidays = false;
    else if (arg.startsWith('--interval=')) opts.interval = arg.split('=')[1];
    else if (arg.startsWith('--range=')) opts.interval = arg.split('=')[1]; // alias
    else if (!arg.startsWith('--')) opts.symbols.push(arg.toUpperCase());
  }

  // Dedupe symbols, preserving order
  opts.symbols = [...new Set(opts.symbols)];

  // Validate interval
  if (!INTERVAL_CONFIG[opts.interval]) {
    console.error(`${RED}Invalid interval: ${opts.interval}${RESET}`);
    console.error(`Valid: ${Object.keys(INTERVAL_CONFIG).join(', ')}`);
    process.exit(1);
  }

  return opts;
}

function showHelp() {
  console.log(`
${bold('momentums.mjs')} ${dim('v2.0')} — Zero-dependency technical analysis

${bold('USAGE:')}
  node momentums.mjs [options] [symbols...]

${bold('OPTIONS:')}
  --interval=<1m|5m|15m|30m|1h|1d|1wk|1mo>   Chart interval ${dim('(default: 1d)')}
  --no-holidays                                Disable US market holiday awareness
  --test                                       Run built-in tests
  --help, -h                                   Show this help

${bold('EXAMPLES:')}
  node momentums.mjs
  node momentums.mjs SPY QQQ IWM
  node momentums.mjs --interval=1h SPY
  node momentums.mjs --interval=15m QQQ TSLA
  node momentums.mjs --interval=1d --no-holidays AAPL
  node momentums.mjs --test

${bold('INTERVAL INFO:')}
  1m   -> 1 day range   (last ~390 min bars)
  5m   -> 5 day range
  15m  -> 5 day range
  30m  -> 1 month
  1h   -> 3 months
  1d   -> 1 year  ${dim('(default)')}
  1wk  -> 5 years
  1mo  -> 10 years
`);
}

/* ================= BUILT-IN TESTS ================= */
function runTests() {
  console.log(`\n${bold(magenta('🧪 RUNNING BUILT-IN TESTS'))}\n`);
  let passed = 0, failed = 0;
  const tests = [];

  // Test 1: isWeekend
  tests.push({
    name: 'isWeekend detects Saturday',
    run: () => isWeekend(new Date('2024-03-16')) === true,
  });
  tests.push({
    name: 'isWeekend detects Sunday',
    run: () => isWeekend(new Date('2024-03-17')) === true,
  });
  tests.push({
    name: 'isWeekend returns false for Monday',
    run: () => isWeekend(new Date('2024-03-18')) === false,
  });
  tests.push({
    name: 'isWeekend returns false for Friday',
    run: () => isWeekend(new Date('2024-03-15')) === false,
  });

  // Test 2: isUSMarketHoliday
  tests.push({
    name: 'isUSMarketHoliday detects Christmas',
    run: () => isUSMarketHoliday(new Date('2024-12-25')) === true,
  });
  tests.push({
    name: 'isUSMarketHoliday detects Thanksgiving',
    run: () => isUSMarketHoliday(new Date('2024-11-28')) === true,
  });
  tests.push({
    name: 'isUSMarketHoliday returns false for regular day',
    run: () => isUSMarketHoliday(new Date('2024-03-15')) === false,
  });
  tests.push({
    name: 'isUSMarketHoliday returns false for weekend (separate check)',
    run: () => isUSMarketHoliday(new Date('2024-03-16')) === false,
  });

  // Test 3: isTradingDay
  tests.push({
    name: 'isTradingDay false on Saturday',
    run: () => isTradingDay(new Date('2024-03-16')) === false,
  });
  tests.push({
    name: 'isTradingDay false on holiday',
    run: () => isTradingDay(new Date('2024-12-25')) === false,
  });
  tests.push({
    name: 'isTradingDay true on normal weekday',
    run: () => isTradingDay(new Date('2024-03-15')) === true,
  });
  tests.push({
    name: 'isTradingDay true when holidays disabled',
    run: () => isTradingDay(new Date('2024-12-25'), false) === true,
  });

  // Test 4: getPreviousTradingClose
  tests.push({
    name: 'getPreviousTradingClose skips weekends',
    run: () => {
      // Simulate: Friday close=100, Saturday=null, Sunday=null
      const candles = [
        { t: new Date('2024-03-15').getTime() / 1000, c: 100 }, // Friday
        { t: new Date('2024-03-16').getTime() / 1000, c: null }, // Saturday (no data)
        { t: new Date('2024-03-17').getTime() / 1000, c: null }, // Sunday (no data)
      ];
      return getPreviousTradingClose(candles, 2) === 100;
    },
  });
  tests.push({
    name: 'getPreviousTradingClose skips holidays',
    run: () => {
      const candles = [
        { t: new Date('2024-12-24').getTime() / 1000, c: 100 }, // Tuesday
        { t: new Date('2024-12-25').getTime() / 1000, c: null }, // Christmas (holiday, no data)
        { t: new Date('2024-12-26').getTime() / 1000, c: 105 }, // Thursday
      ];
      return getPreviousTradingClose(candles, 2) === 105;
    },
  });
  tests.push({
    name: 'getPreviousTradingClose returns null when no prior data',
    run: () => {
      const candles = [{ t: Date.now() / 1000, c: 100 }];
      return getPreviousTradingClose(candles, 0) === null;
    },
  });
  tests.push({
    name: 'getPreviousTradingClose works with holidays disabled',
    run: () => {
      const candles = [
        { t: new Date('2024-12-24').getTime() / 1000, c: 100 },
        { t: new Date('2024-12-25').getTime() / 1000, c: 99 },
      ];
      // With holidays disabled, Christmas counts as a trading day
      return getPreviousTradingClose(candles, 1, false) === 99;
    },
  });

  // Test 5: SMA
  tests.push({
    name: 'sma computes correct simple moving average',
    run: () => {
      const v = [1, 2, 3, 4, 5];
      const result = sma(v, 3);
      return result[2] === 2 && result[3] === 3 && result[4] === 4;
    },
  });
  tests.push({
    name: 'sma fills initial values with null',
    run: () => {
      const v = [1, 2, 3, 4, 5];
      const result = sma(v, 3);
      return result[0] === null && result[1] === null;
    },
  });

  // Test 6: EMA
  tests.push({
    name: 'ema computes correct exponential moving average',
    run: () => {
      const v = [10, 10, 10, 10, 10];
      const result = ema(v, 3);
      // Constant series should yield constant EMA = 10
      return result.every(r => r === null || Math.abs(r - 10) < 0.001);
    },
  });

  // Test 7: RSI
  tests.push({
    name: 'rsi = 100 for constant uptrend',
    run: () => {
      const v = Array.from({ length: 20 }, (_, i) => 100 + i);
      const result = rsi(v, 14);
      return result[result.length - 1] === 100;
    },
  });
  tests.push({
    name: 'rsi = 0 for constant downtrend',
    run: () => {
      const v = Array.from({ length: 20 }, (_, i) => 100 - i);
      const result = rsi(v, 14);
      return result[result.length - 1] === 0;
    },
  });
  tests.push({
    name: 'rsi ~50 for sideways',
    run: () => {
      const v = [50, 51, 50, 49, 50, 51, 50, 49, 50, 51, 50, 49, 50, 51, 50, 49];
      const result = rsi(v, 14);
      const final = result[result.length - 1];
      return final !== null && final > 30 && final < 70;
    },
  });

  // Test 8: Bollinger %B
  tests.push({
    name: 'bollinger %B = 0.5 at middle band',
    run: () => {
      const v = Array.from({ length: 25 }, () => 100);
      const result = bollinger(v, 20);
      return Math.abs(result[result.length - 1] - 0.5) < 0.01;
    },
  });

  // Test 9: MACD
  tests.push({
    name: 'macd line is positive in uptrend',
    run: () => {
      const v = Array.from({ length: 50 }, (_, i) => 100 + i);
      const m = macdCalc(v, 12, 26, 9);
      return m.line[m.line.length - 1] > 0;
    },
  });
  tests.push({
    name: 'macd line is negative in downtrend',
    run: () => {
      const v = Array.from({ length: 50 }, (_, i) => 100 - i);
      const m = macdCalc(v, 12, 26, 9);
      return m.line[m.line.length - 1] < 0;
    },
  });

  // Test 10: verdictFor
  tests.push({
    name: 'verdictFor returns STRONG BULLISH for high score',
    run: () => verdictFor(50) === 'STRONG BULLISH',
  });
  tests.push({
    name: 'verdictFor returns STRONG BEARISH for low score',
    run: () => verdictFor(-50) === 'STRONG BEARISH',
  });
  tests.push({
    name: 'verdictFor returns NEUTRAL for ~0 score',
    run: () => verdictFor(5) === 'NEUTRAL',
  });
  tests.push({
    name: 'verdictFor boundary: 45 = STRONG BULLISH',
    run: () => verdictFor(45) === 'STRONG BULLISH',
  });
  tests.push({
    name: 'verdictFor boundary: 12 = BULLISH',
    run: () => verdictFor(12) === 'BULLISH',
  });

  // Test 11: parseArgs
  tests.push({
    name: 'parseArgs defaults to SPY QQQ',
    run: () => {
      const orig = process.argv;
      process.argv = ['node', 'momentums.mjs'];
      const opts = parseArgs();
      process.argv = orig;
      return opts.symbols.length === 2 && opts.symbols[0] === 'SPY';
    },
  });
  tests.push({
    name: 'parseArgs reads --interval',
    run: () => {
      const orig = process.argv;
      process.argv = ['node', 'momentums.mjs', '--interval=1h', 'AAPL'];
      const opts = parseArgs();
      process.argv = orig;
      return opts.interval === '1h' && opts.symbols.includes('AAPL');
    },
  });
  tests.push({
    name: 'parseArgs reads --test flag',
    run: () => {
      const orig = process.argv;
      process.argv = ['node', 'momentums.mjs', '--test'];
      const opts = parseArgs();
      process.argv = orig;
      return opts.test === true;
    },
  });
  tests.push({
    name: 'parseArgs reads --no-holidays flag',
    run: () => {
      const orig = process.argv;
      process.argv = ['node', 'momentums.mjs', '--no-holidays'];
      const opts = parseArgs();
      process.argv = orig;
      return opts.useHolidays === false;
    },
  });

  // Test 12: Interval config
  tests.push({
    name: 'INTERVAL_CONFIG has all supported intervals',
    run: () => {
      const required = ['1m', '5m', '15m', '30m', '1h', '1d', '1wk', '1mo'];
      return required.every(k => INTERVAL_CONFIG[k] && INTERVAL_CONFIG[k].range);
    },
  });

  // Run all tests
  for (const t of tests) {
    try {
      const ok = t.run();
      if (ok) {
        console.log(`  ${bull('✓')} ${t.name}`);
        passed++;
      } else {
        console.log(`  ${bear('✗')} ${t.name} ${dim('(returned falsy)')}`);
        failed++;
      }
    } catch (e) {
      console.log(`  ${bear('✗')} ${t.name} ${dim(`(threw: ${e.message})`)}`);
      failed++;
    }
  }

  console.log(`\n${bold('Test Results:')} ${bull(`${passed} passed`)} | ${failed > 0 ? bear(`${failed} failed`) : dim('0 failed')}`);
  console.log(`Total: ${passed + failed} tests\n`);

  return failed === 0;
}

/* ================= MAIN ================= */
async function main() {
  const opts = parseArgs();

  if (opts.showHelp) {
    showHelp();
    return;
  }

  if (opts.test) {
    const ok = runTests();
    process.exit(ok ? 0 : 1);
  }

  const scores = [];
  for (const s of opts.symbols) {
    try {
      process.stdout.write(`${dim(`Loading ${s} [${opts.interval}]...`)}`);
      const { meta, candles } = await fetchChart(s, opts.interval);
      process.stdout.write(`\r${' '.repeat(40)}\r`);
      scores.push(analyze(s, candles, meta, { interval: opts.interval, useHolidays: opts.useHolidays }));
    } catch (e) {
      process.stdout.write(`\r${' '.repeat(40)}\r`);
      console.error(`${RED}Failed to load ${s}:${RESET} ${e.message}`);
    }
  }

  if (scores.length) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const mv = verdictFor(avg);
    console.log(`\n${BOLD}==============================${RESET}`);
    console.log(`${BOLD}MARKET VERDICT (avg of ${opts.symbols.join(', ')}):${RESET}  ${bold(verdictColor(mv)(mv))}  ${scoreColor(avg)(`${avg >= 0 ? '+' : ''}${avg.toFixed(1)}`)}`);
    console.log(`${dim(`Interval: ${INTERVAL_CONFIG[opts.interval].label} | Holidays: ${opts.useHolidays ? 'enabled' : 'disabled'}`)}`);
  }
}

// Entry point
main().catch((err) => {
  console.error(`${RED}Fatal error:${RESET} ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
