const { avgVolume, candleBody, candleRange } = require("./utils");

/**
 * Volume spike momentum
 * - Large body candle + close near extremes + volume spike
 */
function volumeSpikeStrategy({ candles, volLookback = 20, volMult = 1.6, bodyFrac = 0.6 }) {
  if (!candles || candles.length < volLookback + 5) return null;

  const last = candles[candles.length - 1];
  const o = Number(last.open);
  const c = Number(last.close);
  const h = Number(last.high);
  const l = Number(last.low);
  const v = Number(last.volume ?? 0);

  const range = candleRange(last);
  if (range <= 0) return null;

  const body = candleBody(last);
  const bodyRatio = body / range;

  const av = avgVolume(candles, volLookback) || 1;
  if (v < av * volMult) return null;
  if (bodyRatio < bodyFrac) return null;

  const bullish = c > o;
  const bearish = c < o;

  const nearHigh = (h - c) / range <= 0.2;
  const nearLow = (c - l) / range <= 0.2;

  if (bullish && nearHigh) {
    const confidence = Math.min(95, 65 + (v / av - volMult) * 10 + (bodyRatio - bodyFrac) * 30);
    return {
      side: "BUY",
      confidence,
      reason: `Volume spike momentum BUY (vol ${(v / av).toFixed(2)}x, body ${(bodyRatio * 100).toFixed(0)}%)`,
    };
  }

  if (bearish && nearLow) {
    const confidence = Math.min(95, 65 + (v / av - volMult) * 10 + (bodyRatio - bodyFrac) * 30);
    return {
      side: "SELL",
      confidence,
      reason: `Volume spike momentum SELL (vol ${(v / av).toFixed(2)}x, body ${(bodyRatio * 100).toFixed(0)}%)`,
    };
  }

  return null;
}

module.exports = { volumeSpikeStrategy };
