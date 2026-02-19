const { avgVolume, maxHigh, minLow } = require("./utils");

/**
 * Range Breakout with volume confirmation
 *
 * BUY: close breaks above max(high) of previous N candles + volume confirmation
 * SELL: close breaks below min(low) of previous N candles + volume confirmation
 */
function breakoutStrategy({ candles, lookback = 20, volMult = 1.2, volLookback = 20 }) {
  if (!candles || candles.length < lookback + 5) return null;

  const n = candles.length;
  const cur = candles[n - 1];
  const prevRange = candles.slice(n - 1 - lookback, n - 1);

  const hi = maxHigh(prevRange);
  const lo = minLow(prevRange);

  const curClose = Number(cur.close);
  const prevClose = Number(candles[n - 2].close);
  const curVol = Number(cur.volume ?? 0);

  const av = avgVolume(candles, volLookback);
  if (!Number.isFinite(av) || av <= 0) return null;

  const volOk = curVol >= av * volMult;

  if (curClose > hi && prevClose <= hi && volOk) {
    const confidence = Math.min(
      92,
      55 + Math.round((curVol / Math.max(1, av)) * 20)
    );
    return {
      side: "BUY",
      reason: `Breakout above ${lookback} candle high`,
      confidence,
    };
  }

  if (curClose < lo && prevClose >= lo && volOk) {
    const confidence = Math.min(
      92,
      55 + Math.round((curVol / Math.max(1, av)) * 20)
    );
    return {
      side: "SELL",
      reason: `Breakdown below ${lookback} candle low`,
      confidence,
    };
  }

  return null;
}

module.exports = { breakoutStrategy };
