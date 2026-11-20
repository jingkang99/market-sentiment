#!/usr/bin/env node
// trend-check.mjs
// ZERO dependencies — Node.js 18+ only (uses built-in fetch() and console).
// BULL = green, BEAR = red, NEUTRAL = yellow — raw ANSI escape codes.
//
// Usage:
//   node trend-check.mjs                 -> SPY QQQ (default)
//   node trend-check.mjs SPY QQQ IWM TLH -> custom symbols

/* ================= RAW ANSI ESCAPE CODES (no libraries) ================= */
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const RED    = '\x1b[31m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';

const bull = (s) => GREEN + s + RESET;   // \x1b[32m green
const bear = (s) => RED + s + RESET;     // \x1b[31m red
const neu  = (s) => YELLOW + s + RESET;  // \x1b[33m yellow
const bold = (s) => BOLD + s + RESET;
const cyan = (s) => CYAN + s + RESET;

const verdictColor = (v) => (v.includes('BULL') ? bull : v.includes('BEAR') ? bear : neu);

/* ================= DATA (Yahoo Finance, built-in fetch) ================= */
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

async function fetchChart(symbol) {
  let lastErr;
  for (const host of HOSTS) {
    try {
      const res = await fetch(
        `${host}/v8/finance/chart/${symbol}?interval=1d&range=1y&includePrePost=false`,
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
      return { meta: r.meta, candles };
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
  for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= p) s -= v[i - p]; if (i >= p - 1) out[i] = s / p; }
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
  for (let i = p; i < v.length; i++) { prev = v[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
};
const rsi = (v, p = 14) => {
  const out = new Array(v.length).fill(null);
  if (v.length <= p) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = v[i] - v[i - 1]; if (d >= 0) g += d; else l -= d; }
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
    for (let i = 0; i < s2.length; i++) if (s2[i] != null) { signal[first + i] = s2[i]; hist[first + i] = line[first + i] - s2[i]; }
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
    for (let j = Math.max(0, i - p + 1); j <= i; j++) if (a[j] != null) { s += a[j]; c++; }
    if (c > 0 && c >= Math.min(p, i + 1)) out[i] = s / c;
  }
  return out;
};
const stochastic = (h, l, c) => {
  const raw = new Array(c.length).fill(null);
  for (let i = 13; i < c.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - 13; j <= i; j++) { if (h[j] > hh) hh = h[j]; if (l[j] < ll) ll = l[j]; }
    raw[i] = hh === ll ? 50 : ((c[i] - ll) / (hh - ll)) * 100;
  }
  const k = smoothN(raw, 3);
  const d = smoothN(k, 3);
  return { k, d };
};
const adxCalc = (h, l, c, p = 14) => {
  const n = c.length;
  const tr = new Array(n).fill(null), pdm = new Array(n).fill(null), mdm = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
    pdm[i] = up > dn && up > 0 ? up : 0;
    mdm[i] = dn > up && dn > 0 ? dn : 0;
    tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  }
  const aS = new Array(n).fill(null), pS = new Array(n).fill(null), mS = new Array(n).fill(null);
  if (n <= p * 2) return null;
  let A = 0, P = 0, M = 0;
  for (let i = 1; i <= p; i++) { A += tr[i]; P += pdm[i]; M += mdm[i]; }
  aS[p] = A; pS[p] = P; mS[p] = M;
  for (let i = p + 1; i < n; i++) {
    aS[i] = aS[i - 1] - aS[i - 1] / p + tr[i];
    pS[i] = pS[i - 1] - pS[i - 1] / p + pdm[i];
    mS[i] = mS[i - 1] - mS[i - 1] / p + mdm[i];
  }
  const plusDI = new Array(n).fill(null), minusDI = new Array(n).fill(null), dx = new Array(n).fill(null);
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
  if (seedIdx !== -1) for (let i = seedIdx + 1; i < n; i++) adxA[i] = (adxA[i - 1] * (p - 1) + dx[i]) / p;
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

function analyze(symbol, candles, meta) {
  const close = candles.map((c) => c.c), high = candles.map((c) => c.h), low = candles.map((c) => c.l);
  const n = close.length, i = n - 1, price = close[i];
  const S20 = sma(close, 20), S50 = sma(close, 50), S200 = sma(close, 200);
  const E12 = ema(close, 12), E26 = ema(close, 26);
  const R = rsi(close, 14), M = macdCalc(close), B = bollinger(close), ST = stochastic(high, low, close);
  const X = adxCalc(high, low, close, 14);

  const sig = [];
  const add = (name, dir, w, note) => sig.push({ name, dir, w, note });

  if (S50[i] != null) add('Price vs SMA 50', price > S50[i] ? 1 : -1, 1.2, `${price.toFixed(2)} vs ${S50[i].toFixed(2)}`);
  if (S200[i] != null) add('Price vs SMA 200', price > S200[i] ? 1 : -1, 1.6, `${price.toFixed(2)} vs ${S200[i].toFixed(2)}`);
  if (S50[i] != null && S200[i] != null) add('SMA 50 vs SMA 200', S50[i] > S200[i] ? 1 : -1, 1.4, S50[i] > S200[i] ? 'golden regime' : 'death regime');
  if (S20[i] != null && S20[i - 5] != null && Math.abs(S20[i] - S20[i - 5]) / S20[i - 5] >= 0.002)
    add('SMA 20 slope (5d)', S20[i] > S20[i - 5] ? 1 : -1, 0.8, S20[i] > S20[i - 5] ? 'rising' : 'falling');
  if (E12[i] != null && E26[i] != null) add('EMA 12 vs EMA 26', E12[i] > E26[i] ? 1 : -1, 1.0, 'momentum');
  if (R[i] != null) add('RSI 14', R[i] > 55 ? 1 : R[i] < 45 ? -1 : 0, 1.3, R[i].toFixed(1));
  if (ST.k[i] != null && ST.d[i] != null) add('Stochastic %K/%D', ST.k[i] > ST.d[i] ? 1 : -1, 0.8, `K ${ST.k[i].toFixed(0)} D ${ST.d[i].toFixed(0)}`);
  if (M.line[i] != null && M.signal[i] != null) {
    add('MACD vs signal', M.line[i] > M.signal[i] ? 1 : -1, 1.3, '');
    add('MACD histogram', M.hist[i] > 0 ? 1 : -1, 0.7, '');
    add('MACD vs zero', M.line[i] > 0 ? 1 : -1, 0.6, M.line[i].toFixed(2));
  }
  if (X && X.adx[i] != null) {
    const strong = X.adx[i] >= 20;
    add('ADX / +DI -DI', !strong ? 0 : X.plusDI[i] > X.minusDI[i] ? 1 : -1, 1.2,
      `ADX ${X.adx[i].toFixed(0)}${!strong ? ' (weak trend)' : ''}`);
  }
  if (B[i] != null) add('Bollinger %B', B[i] > 0.55 ? 1 : B[i] < 0.45 ? -1 : 0, 0.8, `${(B[i] * 100).toFixed(0)}%`);
  const yh = meta.fiftyTwoWeekHigh, yl = meta.fiftyTwoWeekLow;
  if (yh && yl) {
    const pos = ((price - yl) / (yh - yl)) * 100;
    add('52-week position', pos >= 85 ? 1 : pos <= 25 ? -1 : 0, 0.6, `${pos.toFixed(0)}%`);
  }

  const tw = sig.reduce((a, s) => a + s.w, 0) || 1;
  const raw = sig.reduce((a, s) => a + s.w * s.dir, 0);
  const score = Math.max(-100, Math.min(100, (raw / tw) * 100));
  const verdict = verdictFor(score);

  const lastDate = new Date(candles[n - 1].t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const mp = meta.regularMarketPrice ?? price;
  const pc = meta.previousClose;
  const chgPct = pc ? ((mp - pc) / pc) * 100 : 0;
  const chgStr = `${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%`;

  /* ---------- COLORIZED OUTPUT ---------- */
  console.log(`\n${cyan(bold(`=== ${symbol}  (${lastDate}) ===`))}`);
  console.log(`Price ${bold(mp.toFixed(2))}  ${chgPct >= 0 ? bull(chgStr) : bear(chgStr)} vs prev close ${pc ? pc.toFixed(2) : '—'}`);

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

/* ================= MAIN ================= */
const symbols = (process.argv.slice(2).length ? process.argv.slice(2) : ['SPY', 'QQQ']).map((s) => s.toUpperCase());

const scores = [];
for (const s of symbols) {
  try {
    const { meta, candles } = await fetchChart(s);
    scores.push(analyze(s, candles, meta));
  } catch (e) {
    console.error(`${RED}Failed to load ${s}:${RESET} ${e.message}`);
  }
}

if (scores.length) {
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const mv = verdictFor(avg);
  console.log(`\n${BOLD}==============================${RESET}`);
  console.log(`${BOLD}MARKET VERDICT (avg of ${symbols.join(', ')}):${RESET}  ${bold(verdictColor(mv)(mv))}  ${scoreColor(avg)(`${avg >= 0 ? '+' : ''}${avg.toFixed(1)}`)}`);
}

