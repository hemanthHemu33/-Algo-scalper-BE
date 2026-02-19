function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function mean(arr) {
  if (!arr?.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function seeded(seed) {
  let s = Math.max(1, Number(seed) || 1) % 2147483647;
  return () => {
    s = (s * 48271) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

async function calibrateFromRecentTrades({ db, days = 5 }) {
  const from = new Date(Date.now() - Math.max(1, Number(days ?? 5)) * 24 * 60 * 60 * 1000);
  const rows = await db
    .collection('trades')
    .find({ createdAt: { $gte: from } })
    .project({
      expectedEntryPrice: 1,
      entryPrice: 1,
      qty: 1,
      initialQty: 1,
      status: 1,
      createdAt: 1,
      entryFilledAt: 1,
      exitFilledAt: 1,
      exitAt: 1,
      entryPlacedAt: 1,
      quoteAtEntry: 1,
    })
    .limit(3000)
    .toArray();

  const entrySlips = [];
  const spreads = [];
  const fillRatios = [];
  const placeToFill = [];

  for (const t of rows) {
    const exp = n(t.expectedEntryPrice, null);
    const act = n(t.entryPrice, null);
    if (exp > 0 && act > 0) {
      entrySlips.push(Math.abs(((act - exp) / exp) * 10000));
    }
    const q = t?.quoteAtEntry || {};
    const sb = n(q.bps, null);
    if (sb !== null) spreads.push(sb);

    const iq = n(t.initialQty, n(t.qty, null));
    const fq = n(t.qty, null);
    if (iq > 0 && fq !== null) fillRatios.push(clamp(fq / iq, 0, 1));

    const placed = t.entryPlacedAt ? new Date(t.entryPlacedAt).getTime() : null;
    const filled = t.entryFilledAt ? new Date(t.entryFilledAt).getTime() : null;
    if (Number.isFinite(placed) && Number.isFinite(filled) && filled >= placed) {
      placeToFill.push(filled - placed);
    }
  }

  return {
    sampleSize: rows.length,
    avgEntrySlipBps: mean(entrySlips),
    avgSpreadBps: mean(spreads),
    avgFillRatio: mean(fillRatios),
    avgFillLatencyMs: mean(placeToFill),
  };
}

function applyExecutionRealism({
  side,
  intendedPrice,
  candle,
  model,
  rand,
  qty,
}) {
  const rng = rand || Math.random;
  const base = n(intendedPrice, null);
  if (!(base > 0)) return { filledQty: 0, avgFillPrice: null, simulated: false };

  const spreadBps = Math.max(0, n(model?.spreadBps, 6));
  const slipBps = Math.max(0, n(model?.slippageBps, 4));
  const partialProb = clamp(n(model?.partialFillProbability, 0.15), 0, 0.95);
  const minPartial = clamp(n(model?.minPartialFillRatio, 0.35), 0.05, 1);
  const latencyBars = Math.max(0, Math.round(n(model?.latencyBars, 0)));

  let fillRatio = 1;
  if (rng() < partialProb) {
    fillRatio = minPartial + rng() * (1 - minPartial);
  }

  const spreadPx = (base * spreadBps) / 10000;
  const slipPx = (base * slipBps * (0.5 + rng())) / 10000;
  let px = side === 'BUY' ? base + spreadPx * 0.5 + slipPx : base - spreadPx * 0.5 - slipPx;

  const high = n(candle?.high, base);
  const low = n(candle?.low, base);

  // Candle-path realism: randomize which wick is touched first.
  const open = n(candle?.open, base);
  const close = n(candle?.close, base);
  const bullish = close >= open;
  const pathHighFirst = rng() < (bullish ? 0.65 : 0.35);

  if (pathHighFirst) {
    // Early high-touch tends to worsen BUY fills and improve SELL exits.
    px = side === 'BUY' ? clamp(px + spreadPx * 0.15, low, high) : clamp(px - spreadPx * 0.1, low, high);
  } else {
    // Early low-touch does the opposite.
    px = side === 'BUY' ? clamp(px - spreadPx * 0.1, low, high) : clamp(px + spreadPx * 0.15, low, high);
  }

  const requestedQty = Math.max(1, Math.round(n(qty, 1)));
  const filledQty = Math.max(1, Math.min(requestedQty, Math.round(requestedQty * fillRatio)));

  return {
    simulated: true,
    latencyBars,
    filledQty,
    avgFillPrice: px,
    spreadBps,
    slippageBps: slipBps,
    fillRatio: filledQty / requestedQty,
  };
}

module.exports = { calibrateFromRecentTrades, applyExecutionRealism, seeded };
