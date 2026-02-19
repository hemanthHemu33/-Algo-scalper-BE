const { avgVolume, maxHigh, minLow, upperWick, lowerWick, candleRange } = require("./utils");

/**
 * Failed breakout / fakeout
 * - Previous candle breaks range, current candle closes back inside => fade the move
 */
function fakeoutStrategy({ candles, lookback = 20, volLookback = 20, volMult = 1.0 }) {
  if (!candles || candles.length < lookback + 5) return null;

  const cur = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const base = candles.slice(-(lookback + 2), -2);
  const hi = maxHigh(base);
  const lo = minLow(base);

  const prevClose = Number(prev.close);
  const curClose = Number(cur.close);
  const curOpen = Number(cur.open);

  const av = avgVolume(candles, volLookback) || 1;
  const v = Number(cur.volume ?? 0);
  if (v < av * volMult) return null;

  // upside fakeout -> SELL
  if (prevClose > hi && curClose < hi && curClose < curOpen) {
    const r = candleRange(cur) || 1;
    const wick = upperWick(cur) / r;
    const confidence = Math.min(92, 62 + wick * 30 + Math.max(0, (v / av - volMult) * 10));
    return {
      side: "SELL",
      confidence,
      reason: `Fakeout SELL: broke above ${hi.toFixed(2)} then closed back below`,
    };
  }

  // downside fakeout -> BUY
  if (prevClose < lo && curClose > lo && curClose > curOpen) {
    const r = candleRange(cur) || 1;
    const wick = lowerWick(cur) / r;
    const confidence = Math.min(92, 62 + wick * 30 + Math.max(0, (v / av - volMult) * 10));
    return {
      side: "BUY",
      confidence,
      reason: `Fakeout BUY: broke below ${lo.toFixed(2)} then closed back above`,
    };
  }

  return null;
}

module.exports = { fakeoutStrategy };
