const { avgVolume, bollingerBands } = require("./utils");

/**
 * Bollinger Band Squeeze Breakout
 * - when band width is tight (widthPct <= squeezePct), trade breakout beyond bands with volume
 */
function bollingerSqueezeStrategy({
  candles,
  period = 20,
  std = 2,
  squeezePct = 0.012,
  volLookback = 20,
  volMult = 1.1,
}) {
  if (!candles || candles.length < period + 5) return null;

  const bb = bollingerBands(candles, period, std);
  if (!bb) return null;

  if (bb.widthPct > squeezePct) return null;

  const last = candles[candles.length - 1];
  const close = Number(last.close);
  const vol = Number(last.volume ?? 0);
  const av = avgVolume(candles, volLookback) || 1;

  if (close > bb.upper && vol >= av * volMult) {
    const tightScore = Math.max(0, (squeezePct - bb.widthPct) / squeezePct);
    const volScore = Math.max(0, (vol / av - volMult) / Math.max(0.1, volMult));
    const confidence = Math.min(95, 65 + tightScore * 20 + volScore * 10);
    return {
      side: "BUY",
      confidence,
      reason: `BB squeeze breakout (width ${(bb.widthPct * 100).toFixed(2)}%) above upper ${bb.upper.toFixed(2)}`,
    };
  }

  if (close < bb.lower && vol >= av * volMult) {
    const tightScore = Math.max(0, (squeezePct - bb.widthPct) / squeezePct);
    const volScore = Math.max(0, (vol / av - volMult) / Math.max(0.1, volMult));
    const confidence = Math.min(95, 65 + tightScore * 20 + volScore * 10);
    return {
      side: "SELL",
      confidence,
      reason: `BB squeeze breakdown (width ${(bb.widthPct * 100).toFixed(2)}%) below lower ${bb.lower.toFixed(2)}`,
    };
  }

  return null;
}

module.exports = { bollingerSqueezeStrategy };
