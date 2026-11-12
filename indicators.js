/* indicators.js — all indicator maths, shared by the cards and the charts */

export function last(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}

export function smaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

/* EMA over a sparse series (skips nulls) — used for the MACD signal line */
export function emaSparse(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let ema = null, count = 0, sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null || !isFinite(v)) continue;
    count += 1;
    sum += v;
    if (count === period) ema = sum / period;
    else if (ema !== null) ema = v * k + ema * (1 - k);
    if (ema !== null) out[i] = ema;
  }
  return out;
}

export function rsiSeries(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;
  for (let i = period; i < values.length; i++) {
    let gains = 0, losses = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const ch = values[j] - values[j - 1];
      if (ch >= 0) gains += ch;
      else losses -= ch;
    }
    const ag = gains / period, al = losses / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

/* MACD(12, 26, 9) -> line, 9-period signal EMA, histogram */
export function macdSeries(values, fast = 12, slow = 26, signalPeriod = 9) {
  const f = emaSeries(values, fast);
  const s = emaSeries(values, slow);
  const macd = values.map((_, i) => (f[i] != null && s[i] != null ? f[i] - s[i] : null));
  const signal = emaSparse(macd, signalPeriod);
  const hist = macd.map((m, i) => (m != null && signal[i] != null ? m - signal[i] : null));
  return { macd, signal, hist };
}

export function stdevSeries(values, period) {
  const mid = smaSeries(values, period);
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = values[j] - mid[i];
      s += d * d;
    }
    out[i] = Math.sqrt(s / period);
  }
  return out;
}

export function bollingerSeries(values, period = 20, mult = 2) {
  const mid = smaSeries(values, period);
  const sd = stdevSeries(values, period);
  const upper = mid.map((m, i) => (m == null || sd[i] == null ? null : m + mult * sd[i]));
  const lower = mid.map((m, i) => (m == null || sd[i] == null ? null : m - mult * sd[i]));
  return { mid, upper, lower, sd };
}

/* rolling N-day volume-weighted average price (typical price HLC3) */
export function vwapSeries(values, volumes, period = 20) {
  const out = new Array(values.length).fill(null);
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < values.length; i++) {
    const v = volumes[i] || 0;
    pv += values[i] * v;
    vol += v;
    if (i >= period) {
      pv -= values[i - period] * (volumes[i - period] || 0);
      vol -= volumes[i - period] || 0;
    }
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}

export function percentB(price, upper, lower) {
  if (price == null || upper == null || lower == null || upper === lower) return null;
  return ((price - lower) / (upper - lower)) * 100;
}

/* Attach every indicator to every bar so the charts and cards share one source of truth */
export function analyze(bars) {
  const list = bars || [];
  const closes = list.map((b) => b.c);
  const volumes = list.map((b) => b.v || 0);

  const sma20 = smaSeries(closes, 20);
  const sma50 = smaSeries(closes, 50);
  const ema21 = emaSeries(closes, 21);
  const rsi14 = rsiSeries(closes, 14);
  const rsi21 = rsiSeries(closes, 21);
  const { macd, signal, hist } = macdSeries(closes, 12, 26, 9);
  const bb = bollingerSeries(closes, 20, 2);
  const vwap = vwapSeries(closes, volumes, 20);

  const enriched = list.map((b, i) => ({
    ...b,
    sma20: sma20[i],
    sma50: sma50[i],
    ema21: ema21[i],
    rsi: rsi14[i],
    rsi21: rsi21[i],
    macd: macd[i],
    macdSignal: signal[i],
    macdHist: hist[i],
    bbU: bb.upper[i],
    bbM: bb.mid[i],
    bbL: bb.lower[i],
    vwap: vwap[i],
    pctB: percentB(b.c, bb.upper[i], bb.lower[i]),
  }));

  const price = closes.length ? closes[closes.length - 1] : null;
  return {
    closes,
    enriched,
    sma20: last(sma20),
    sma50: last(sma50),
    ema21: last(ema21),
    rsi: last(rsi14),
    rsi21: last(rsi21),
    macd: last(macd),
    macdSignal: last(signal),
    macdHist: last(hist),
    bbU: last(bb.upper),
    bbM: last(bb.mid),
    bbL: last(bb.lower),
    pctB: percentB(price, last(bb.upper), last(bb.lower)),
    vwap: last(vwap),
  };
}

