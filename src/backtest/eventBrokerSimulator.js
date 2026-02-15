function n(v, d = null) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function roundQty(v) {
  return Math.max(1, Math.round(Number(v) || 1));
}

function deriveBidAsk(mid, spreadBps) {
  const halfSpread = (mid * Math.max(0, spreadBps)) / 20000;
  return {
    bid: Math.max(0.01, mid - halfSpread),
    ask: Math.max(0.01, mid + halfSpread),
  };
}

function simulateOrderLifecycle({
  side,
  intent,
  candle,
  qty,
  nowTs,
  model,
  rand,
}) {
  const rng = rand || Math.random;
  const requestedQty = roundQty(qty);
  const mid = n(intent?.price, n(candle?.close, null));
  if (!(mid > 0)) {
    return { status: 'REJECTED', rejectReason: 'INVALID_PRICE', requestedQty, filledQty: 0 };
  }

  const spreadBps = Math.max(0, n(model?.spreadBps, 6));
  const slippageBps = Math.max(0, n(model?.slippageBps, 3));
  const partialProb = clamp(n(model?.partialFillProbability, 0.15), 0, 0.95);
  const minPartial = clamp(n(model?.minPartialFillRatio, 0.35), 0.05, 1);
  const latencyBars = Math.max(0, Math.round(n(model?.latencyBars, 0)));
  const tick = Math.max(0.01, n(model?.tickSize, 0.05));

  const { bid, ask } = deriveBidAsk(mid, spreadBps);
  const triggerPrice = n(intent?.triggerPrice, null);
  if (triggerPrice !== null && Math.abs((triggerPrice / tick) - Math.round(triggerPrice / tick)) > 1e-6) {
    return { status: 'REJECTED', rejectReason: 'INVALID_TRIGGER_TICK', requestedQty, filledQty: 0 };
  }

  const events = [{ type: 'PLACED', ts: new Date(nowTs || Date.now()), orderType: intent?.type || 'MARKET' }];

  if (latencyBars > 0) {
    events.push({ type: 'PENDING', latencyBars });
  }

  const fillRatio = rng() < partialProb ? minPartial + rng() * (1 - minPartial) : 1;
  const filledQty = Math.max(1, Math.min(requestedQty, Math.round(requestedQty * fillRatio)));

  const baseFill = side === 'BUY' ? ask : bid;
  const slipPx = (mid * slippageBps * (0.5 + rng())) / 10000;
  const rawFill = side === 'BUY' ? baseFill + slipPx : baseFill - slipPx;
  const hi = n(candle?.high, mid);
  const lo = n(candle?.low, mid);
  const avgFillPrice = clamp(rawFill, Math.min(lo, hi), Math.max(lo, hi));

  events.push({
    type: filledQty < requestedQty ? 'PARTIAL_FILL' : 'FILLED',
    ts: new Date(nowTs || Date.now()),
    qty: filledQty,
    avgFillPrice,
  });

  if (filledQty < requestedQty) {
    events.push({ type: 'CANCELLED_REMAINDER', qty: requestedQty - filledQty });
  }

  return {
    status: filledQty > 0 ? 'FILLED' : 'CANCELLED',
    requestedQty,
    filledQty,
    avgFillPrice,
    spreadBps,
    slippageBps,
    latencyBars,
    bid,
    ask,
    events,
  };
}

module.exports = { simulateOrderLifecycle };
