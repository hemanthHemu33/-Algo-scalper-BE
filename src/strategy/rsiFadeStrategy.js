const { rollingVWAP, rsi } = require("./utils");

/**
 * RSI mean-reversion fade
 * - BUY when RSI oversold and price below VWAP
 * - SELL when RSI overbought and price above VWAP
 */
function rsiFadeStrategy({ candles, period = 14, ob = 70, os = 30, vwapLookback = 120 }) {
  if (!candles || candles.length < period + 10) return null;

  const last = candles[candles.length - 1];
  const close = Number(last.close);
  const v = rollingVWAP(candles, vwapLookback);
  const val = rsi(candles, period);
  if (val == null || !Number.isFinite(v)) return null;

  const dist = v !== 0 ? (close - v) / v : 0;

  if (val <= os && close < v) {
    const confidence = Math.min(90, 60 + (os - val) * 1.0 + Math.min(15, Math.abs(dist) * 1000));
    return {
      side: "BUY",
      confidence,
      reason: `RSI fade BUY (RSI ${val.toFixed(1)} <= ${os}) below VWAP (${v.toFixed(2)})`,
    };
  }

  if (val >= ob && close > v) {
    const confidence = Math.min(90, 60 + (val - ob) * 1.0 + Math.min(15, Math.abs(dist) * 1000));
    return {
      side: "SELL",
      confidence,
      reason: `RSI fade SELL (RSI ${val.toFixed(1)} >= ${ob}) above VWAP (${v.toFixed(2)})`,
    };
  }

  return null;
}

module.exports = { rsiFadeStrategy };
