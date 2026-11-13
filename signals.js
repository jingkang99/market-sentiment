/* signals.js — bull / bear / neutral scoring rules
 *
 * Add a new condition by appending an object to RULES.
 * Each rule receives a context object (price + indicators) and must return either:
 *   { score: number, reason: string }   — contribute to the total
 *   null / undefined                    — skip (missing data or not applicable)
 *
 * Context fields currently available (from analyze()):
 *   price, sma20, sma50, ema21, rsi, rsi21, macd, macdSignal, macdHist,
 *   bbU, bbM, bbL, pctB, vwap, adx, plusDI, minusDI
 */

/* ---------- thresholds (tune here) ---------- */

export const THRESHOLDS = {
  bullish: 2,       // single-symbol score >= this  → BULLISH
  bearish: -1.5,    // single-symbol score <= this → BEARISH
  overallBull: 1.5, // average of symbols >= this  → BULLISH
  overallBear: -1,  // average of symbols <= this  → BEARISH
  adxStrong: 25,    // ADX above this = strong trend
};

/* ---------- individual rules ---------- */

export const RULES = [
  {
    id: "trend-sma",
    description: "Price vs SMA20 / SMA50 trend stack",
    evaluate(ctx) {
      const { price, sma20, sma50 } = ctx;
      if (sma20 == null || sma50 == null || price == null) return null;
      if (price > sma20 && sma20 > sma50) {
        return { score: 2, reason: "Price above SMA20 and SMA20 above SMA50 (strong uptrend)" };
      }
      if (price > sma20) {
        return { score: 1, reason: "Price above SMA20 (short-term bullish)" };
      }
      if (price < sma20 && sma20 < sma50) {
        return { score: -2, reason: "Price below SMA20 and SMA20 below SMA50 (strong downtrend)" };
      }
      if (price < sma20) {
        return { score: -1, reason: "Price below SMA20 (short-term bearish)" };
      }
      return null;
    },
  },

  {
    id: "rsi-momentum",
    description: "RSI(14) momentum / overbought / oversold",
    evaluate(ctx) {
      const { rsi } = ctx;
      if (rsi == null) return null;
      if (rsi > 55 && rsi < 70) {
        return { score: 1, reason: "RSI " + rsi.toFixed(1) + " - healthy bullish momentum" };
      }
      if (rsi >= 70) {
        return { score: -0.5, reason: "RSI " + rsi.toFixed(1) + " - overbought (caution)" };
      }
      if (rsi < 45 && rsi > 30) {
        return { score: -1, reason: "RSI " + rsi.toFixed(1) + " - bearish momentum" };
      }
      if (rsi <= 30) {
        return { score: 0.5, reason: "RSI " + rsi.toFixed(1) + " - oversold (potential bounce)" };
      }
      return null;
    },
  },

  {
    id: "macd-sign",
    description: "MACD line above / below zero",
    evaluate(ctx) {
      const { macd } = ctx;
      if (macd == null) return null;
      if (macd > 0) {
        return { score: 1, reason: "MACD positive (bullish momentum)" };
      }
      return { score: -1, reason: "MACD negative (bearish momentum)" };
    },
  },

  {
    id: "adx-strength",
    description: "ADX(14) trend strength with +DI / -DI direction",
    evaluate(ctx) {
      const { adx, plusDI, minusDI } = ctx;
      if (adx == null) return null;
      const thr = THRESHOLDS.adxStrong;
      if (adx > thr) {
        // Strong trend — direction from DI balance
        if (plusDI != null && minusDI != null && plusDI > minusDI) {
          return {
            score: 1,
            reason: "ADX " + adx.toFixed(1) + " > " + thr + " with +DI > -DI (strong uptrend)",
          };
        }
        if (plusDI != null && minusDI != null && minusDI > plusDI) {
          return {
            score: -1,
            reason: "ADX " + adx.toFixed(1) + " > " + thr + " with -DI > +DI (strong downtrend)",
          };
        }
        return {
          score: 0.5,
          reason: "ADX " + adx.toFixed(1) + " > " + thr + " (strong trend, direction unclear)",
        };
      }
      // Weak / ranging market
      return {
        score: -0.25,
        reason: "ADX " + adx.toFixed(1) + " <= " + thr + " (weak / ranging trend)",
      };
    },
  },

  /* ---- examples of extra rules you can enable later ----
  {
    id: "ema21-price",
    description: "Price vs EMA21",
    evaluate(ctx) {
      const { price, ema21 } = ctx;
      if (price == null || ema21 == null) return null;
      if (price > ema21) return { score: 0.5, reason: "Price above EMA21" };
      return { score: -0.5, reason: "Price below EMA21" };
    },
  },
  {
    id: "bollinger-pctb",
    description: "%B position in Bollinger bands",
    evaluate(ctx) {
      const { pctB } = ctx;
      if (pctB == null) return null;
      if (pctB >= 100) return { score: -0.5, reason: "%B " + pctB.toFixed(0) + " - above upper band (stretched)" };
      if (pctB <= 0) return { score: 0.5, reason: "%B " + pctB.toFixed(0) + " - below lower band (oversold)" };
      return null;
    },
  },
  {
    id: "macd-histogram",
    description: "MACD histogram direction",
    evaluate(ctx) {
      const { macdHist } = ctx;
      if (macdHist == null) return null;
      if (macdHist > 0) return { score: 0.5, reason: "MACD histogram positive" };
      if (macdHist < 0) return { score: -0.5, reason: "MACD histogram negative" };
      return null;
    },
  },
  */
];

/* ---------- scoring helpers ---------- */

export function labelFromScore(score, bull = THRESHOLDS.bullish, bear = THRESHOLDS.bearish) {
  if (score >= bull) return "BULLISH";
  if (score <= bear) return "BEARISH";
  return "NEUTRAL";
}

/**
 * Build a signal for one symbol.
 * @param {object} ctx  price + indicator snapshot (see RULES header)
 * @param {object[]} [rules=RULES]  optional override for tests / experiments
 * @returns {{ score: number, label: string, reasons: string[], hits: object[] }}
 */
export function getSignal(ctx, rules = RULES) {
  let score = 0;
  const reasons = [];
  const hits = [];

  for (const rule of rules) {
    try {
      const result = rule.evaluate(ctx);
      if (!result || result.score == null) continue;
      score += result.score;
      if (result.reason) reasons.push(result.reason);
      hits.push({ id: rule.id, score: result.score, reason: result.reason });
    } catch (e) {
      console.warn("[signals] rule " + rule.id + " failed:", e && e.message);
    }
  }

  return {
    score,
    label: labelFromScore(score),
    reasons,
    hits,
  };
}

/**
 * Average several symbol signals into an overall market bias.
 * @param {Array<{ score: number }>} signals
 */
export function combineSignals(signals) {
  const list = (signals || []).filter((s) => s && typeof s.score === "number");
  if (!list.length) {
    return { score: 0, label: "NEUTRAL" };
  }
  const score = list.reduce((sum, s) => sum + s.score, 0) / list.length;
  return {
    score,
    label: labelFromScore(score, THRESHOLDS.overallBull, THRESHOLDS.overallBear),
  };
}

/**
 * Convenience: build context from a quote + analyze() result.
 */
export function contextFrom(data, analysis) {
  if (!data || !analysis) return {};
  return {
    price: data.price,
    sma20: analysis.sma20,
    sma50: analysis.sma50,
    ema21: analysis.ema21,
    rsi: analysis.rsi,
    rsi21: analysis.rsi21,
    macd: analysis.macd,
    macdSignal: analysis.macdSignal,
    macdHist: analysis.macdHist,
    bbU: analysis.bbU,
    bbM: analysis.bbM,
    bbL: analysis.bbL,
    pctB: analysis.pctB,
    vwap: analysis.vwap,
    adx: analysis.adx,
    plusDI: analysis.plusDI,
    minusDI: analysis.minusDI,
  };
}
