const { candleRange, upperWick, lowerWick } = require("./utils");

/**
 * Exhaustion wick reversal
 * - After a short trend, prints a long wick -> reversal scalp
 */
function wickReversalStrategy({ candles, lookback = 20, minWickFrac = 0.6 }) {
  if (!candles || candles.length < lookback + 5) return null;

  const cur = candles[candles.length - 1];
  const r = candleRange(cur);
  if (r <= 0) return null;

  const base = candles.slice(-lookback - 1, -1);
  const first = Number(base[0].close);
  const last = Number(base[base.length - 1].close);

  const upTrend = last > first;
  const downTrend = last < first;

  const o = Number(cur.open);
  const c = Number(cur.close);

  const uw = upperWick(cur) / r;
  const lw = lowerWick(cur) / r;

  if (upTrend && uw >= minWickFrac && c < o) {
    const confidence = Math.min(90, 60 + uw * 35);
    return {
      side: "SELL",
      confidence,
      reason: `Exhaustion wick SELL (upper wick ${(uw * 100).toFixed(0)}%)`,
    };
  }

  if (downTrend && lw >= minWickFrac && c > o) {
    const confidence = Math.min(90, 60 + lw * 35);
    return {
      side: "BUY",
      confidence,
      reason: `Exhaustion wick BUY (lower wick ${(lw * 100).toFixed(0)}%)`,
    };
  }

  return null;
}

module.exports = { wickReversalStrategy };
