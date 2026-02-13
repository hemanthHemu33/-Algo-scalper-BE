const { emaSeries } = require("./ema");
const { avgVolume, rollingVWAP } = require("./utils");

/**
 * Rolling VWAP reclaim / reject
 *
 * BUY: previous close below VWAP, current close above VWAP (+ optional volume filter)
 * SELL: previous close above VWAP, current close below VWAP
 *
 * Notes:
 * - Uses "rolling VWAP" over last `lookback` candles (default 120) because we may not
 *   have all candles since day open in DB.
 */
function vwapReclaimStrategy({
  candles,
  lookback = 120,
  volLookback = 20,
  volMult = 1.0,
  fast = 9,
  slow = 21,
}) {
  if (!candles || candles.length < Math.max(slow, lookback) + 5) return null;

  const n = candles.length;
  const prevClose = Number(candles[n - 2].close);
  const curClose = Number(candles[n - 1].close);

  const vwapPrev = rollingVWAP(candles.slice(0, n - 1), lookback);
  const vwapCur = rollingVWAP(candles, lookback);

  const curVol = Number(candles[n - 1].volume || 0);
  const av = avgVolume(candles, volLookback);
  if (!Number.isFinite(av) || av <= 0) return null;

  const volOk = curVol >= av * volMult;

  // Simple trend filter using EMA (prevents too many chop signals)
  const closes = candles.map(c => Number(c.close));
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const trendUp = emaFast[n - 1] > emaSlow[n - 1];
  const trendDown = emaFast[n - 1] < emaSlow[n - 1];

  if (prevClose < vwapPrev && curClose > vwapCur && volOk && trendUp) {
    const confidence = Math.min(
      90,
      52 + Math.round((curVol / Math.max(1, av)) * 15)
    );
    return {
      side: "BUY",
      reason: `VWAP reclaim (rolling ${lookback})`,
      confidence,
    };
  }

  if (prevClose > vwapPrev && curClose < vwapCur && volOk && trendDown) {
    const confidence = Math.min(
      90,
      52 + Math.round((curVol / Math.max(1, av)) * 15)
    );
    return {
      side: "SELL",
      reason: `VWAP reject (rolling ${lookback})`,
      confidence,
    };
  }

  return null;
}

module.exports = { vwapReclaimStrategy };
