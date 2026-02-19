const { emaSeries } = require("./ema");
const { avgVolume } = require("./utils");

/**
 * EMA Pullback Reclaim (scalping-friendly, more frequent than pure EMA cross)
 *
 * BUY:
 *  - Trend up: EMAfast > EMAslow
 *  - Price "reclaims" EMAfast: previous close below EMAfast, current close above EMAfast
 *  - Current close above EMAslow (avoid chop)
 *  - Optional: volume >= avgVol * volMult
 *
 * SELL: mirrored.
 */
function emaPullbackStrategy({
  candles,
  fast = 9,
  slow = 21,
  volLookback = 20,
  volMult = 1.1,
}) {
  if (!candles || candles.length < Math.max(fast, slow) + 5) return null;

  const closes = candles.map(c => Number(c.close));
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);

  const n = closes.length;
  const prevClose = closes[n - 2];
  const curClose = closes[n - 1];
  const prevFast = emaFast[n - 2];
  const curFast = emaFast[n - 1];
  const curSlow = emaSlow[n - 1];

  const curVol = Number(candles[n - 1].volume ?? 0);
  const av = avgVolume(candles, volLookback);
  if (!Number.isFinite(av) || av <= 0) return null;

  const volOk = curVol >= av * volMult;

  // BUY setup
  const trendUp = curFast > curSlow;
  const reclaimUp = prevClose < prevFast && curClose > curFast;
  const aboveSlow = curClose > curSlow;

  if (trendUp && reclaimUp && aboveSlow && volOk) {
    const confidence = Math.min(
      90,
      50 + Math.round((curVol / Math.max(1, av)) * 15)
    );
    return {
      side: "BUY",
      reason: `EMA pullback reclaim (EMA${fast} reclaimed in uptrend)`,
      confidence,
    };
  }

  // SELL setup
  const trendDown = curFast < curSlow;
  const reclaimDown = prevClose > prevFast && curClose < curFast;
  const belowSlow = curClose < curSlow;

  if (trendDown && reclaimDown && belowSlow && volOk) {
    const confidence = Math.min(
      90,
      50 + Math.round((curVol / Math.max(1, av)) * 15)
    );
    return {
      side: "SELL",
      reason: `EMA pullback reclaim (EMA${fast} rejected in downtrend)`,
      confidence,
    };
  }

  return null;
}

module.exports = { emaPullbackStrategy };
