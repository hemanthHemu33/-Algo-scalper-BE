const { emaSeries } = require("./ema");

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function emaCrossStrategy({ candles, fast = 9, slow = 21 }) {
  if (!candles || candles.length < Math.max(fast, slow) + 2) return null;

  const closes = candles.map((c) => Number(c.close)).filter(Number.isFinite);
  if (closes.length < Math.max(fast, slow) + 2) return null;

  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);

  const n = closes.length;
  const prevFast = Number(emaFast[n - 2]);
  const prevSlow = Number(emaSlow[n - 2]);
  const curFast = Number(emaFast[n - 1]);
  const curSlow = Number(emaSlow[n - 1]);
  const price = Number(closes[n - 1]);

  if (
    ![prevFast, prevSlow, curFast, curSlow, price].every(Number.isFinite) ||
    price <= 0
  ) {
    return null;
  }

  const crossedUp = prevFast <= prevSlow && curFast > curSlow;
  const crossedDown = prevFast >= prevSlow && curFast < curSlow;
  if (!crossedUp && !crossedDown) return null;

  // --- confidence model (pro-ish, cheap + effective) ---
  // 1) separation strength (bps)
  const diff = Math.abs(curFast - curSlow);
  const diffBps = (diff / price) * 10000; // basis points

  // 2) slope alignment (avoid flat/whipsaw crosses)
  const slopeFast = curFast - prevFast;
  const slopeSlow = curSlow - prevSlow;
  const slopeAligned = crossedUp
    ? slopeFast > 0 && slopeSlow >= 0
    : slopeFast < 0 && slopeSlow <= 0;

  // scoring
  const scoreDiff = clamp(diffBps * 1.2, 0, 30); // ~25 bps => ~30 pts
  const scoreSlope = slopeAligned ? 15 : 5;

  // whipsaw penalty when separation is tiny
  const whipsawPenalty = diffBps < 6 ? -20 : diffBps < 12 ? -10 : 0;

  const confidence = clamp(
    55 + scoreDiff + scoreSlope + whipsawPenalty,
    0,
    100
  );

  if (crossedUp) {
    return {
      side: "BUY",
      reason: `EMA${fast} crossed above EMA${slow}`,
      confidence,
      meta: { diffBps, slopeFast, slopeSlow },
    };
  }

  return {
    side: "SELL",
    reason: `EMA${fast} crossed below EMA${slow}`,
    confidence,
    meta: { diffBps, slopeFast, slopeSlow },
  };
}

module.exports = { emaCrossStrategy };
