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

/**
 * Wilder ADX(period) with +DI / -DI.
 * Returns { adx, plusDI, minusDI } series (null until enough bars).
 */
export function adxSeries(bars, period = 14) {
  const n = (bars || []).length;
  const adx = new Array(n).fill(null);
  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  if (n < period + 2) return { adx, plusDI, minusDI };

  const tr = new Array(n).fill(0);
  const pdm = new Array(n).fill(0);
  const mdm = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const h = bars[i].h;
    const l = bars[i].l;
    const prevC = bars[i - 1].c;
    const prevH = bars[i - 1].h;
    const prevL = bars[i - 1].l;
    const up = h - prevH;
    const down = prevL - l;
    pdm[i] = up > down && up > 0 ? up : 0;
    mdm[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
  }

  // First Wilder smooth: sum of first `period` values starting at index 1
  let atr = 0;
  let pDM = 0;
  let mDM = 0;
  for (let i = 1; i <= period; i++) {
    atr += tr[i];
    pDM += pdm[i];
    mDM += mdm[i];
  }

  const dxArr = new Array(n).fill(null);
  const diAt = (idx, smoothP, smoothM, smoothTR) => {
    if (!smoothTR) return { pdi: null, mdi: null, dx: null };
    const pdi = 100 * (smoothP / smoothTR);
    const mdi = 100 * (smoothM / smoothTR);
    const den = pdi + mdi;
    const dx = den === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / den;
    plusDI[idx] = pdi;
    minusDI[idx] = mdi;
    dxArr[idx] = dx;
    return { pdi, mdi, dx };
  };

  diAt(period, pDM, mDM, atr);

  for (let i = period + 1; i < n; i++) {
    atr = atr - atr / period + tr[i];
    pDM = pDM - pDM / period + pdm[i];
    mDM = mDM - mDM / period + mdm[i];
    diAt(i, pDM, mDM, atr);
  }

  // First ADX = average of first `period` DX values (from index period .. 2*period-1)
  const adxStart = period * 2 - 1;
  if (adxStart >= n) return { adx, plusDI, minusDI };

  let adxVal = 0;
  let counted = 0;
  for (let i = period; i <= adxStart; i++) {
    if (dxArr[i] != null) {
      adxVal += dxArr[i];
      counted += 1;
    }
  }
  if (counted > 0) {
    adxVal /= counted;
    adx[adxStart] = adxVal;
  }

  for (let i = adxStart + 1; i < n; i++) {
    if (dxArr[i] == null || adxVal == null) continue;
    adxVal = (adxVal * (period - 1) + dxArr[i]) / period;
    adx[i] = adxVal;
  }

  return { adx, plusDI, minusDI };
}

/* Attach every indicator to every bar so the charts and cards share one source of truth */
export function analyze(bars) {
  const list = bars || [];
  const closes = list.map((b) => b.c);
  const volumes = list.map((b) => b.v || 0);

  const sma20 = smaSeries(closes, 20);
  const sma50 = smaSeries(closes, 50);
  const ema21 = emaSeries(closes, 21);
  const ema200 = emaSeries(closes, 200);
  const rsi14 = rsiSeries(closes, 14);
  const rsi21 = rsiSeries(closes, 21);
  const { macd, signal, hist } = macdSeries(closes, 12, 26, 9);
  const bb = bollingerSeries(closes, 20, 2);
  const vwap = vwapSeries(closes, volumes, 20);
  const volSma21 = smaSeries(volumes, 21);
  const { adx, plusDI, minusDI } = adxSeries(list, 14);

  const enriched = list.map((b, i) => ({
    ...b,
    sma20: sma20[i],
    sma50: sma50[i],
    ema21: ema21[i],
    ema200: ema200[i],
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
    volSma21: volSma21[i],
    adx: adx[i],
    plusDI: plusDI[i],
    minusDI: minusDI[i],
  }));

  const price = closes.length ? closes[closes.length - 1] : null;
  return {
    closes,
    enriched,
    sma20: last(sma20),
    sma50: last(sma50),
    ema21: last(ema21),
    ema200: last(ema200),
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
    volSma21: last(volSma21),
    adx: last(adx),
    plusDI: last(plusDI),
    minusDI: last(minusDI),
  };
}

