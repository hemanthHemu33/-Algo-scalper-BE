function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toBps(spread, mid) {
  if (!(spread > 0) || !(mid > 0)) return null;
  return (spread / mid) * 10000;
}

function getEffectivePrice(snapshot = {}, opts = {}) {
  const ltp = safeNum(snapshot.ltp ?? snapshot.last_price);
  const bid = safeNum(snapshot.bestBid ?? snapshot.bid ?? snapshot?.depth?.buy?.[0]?.price);
  const ask = safeNum(snapshot.bestAsk ?? snapshot.ask ?? snapshot?.depth?.sell?.[0]?.price);
  const nowMs = safeNum(opts.nowMs) ?? Date.now();
  const maxSpreadBps = safeNum(opts.maxSpreadBps);
  const maxQuoteAgeMs = safeNum(opts.maxQuoteAgeMs);
  const quoteTsMs = safeNum(snapshot.quoteTsMs ?? snapshot.tsMs ?? snapshot.timestamp);
  const ageMs = Number.isFinite(quoteTsMs) ? Math.max(0, nowMs - quoteTsMs) : null;

  let effective = ltp;
  let source = "ltp";
  let spreadBps = null;
  let spreadOk = true;
  let ageOk = true;

  if (Number.isFinite(bid) && Number.isFinite(ask) && ask >= bid && bid > 0) {
    const mid = (bid + ask) / 2;
    spreadBps = toBps(ask - bid, mid);
    spreadOk = !Number.isFinite(maxSpreadBps) || !Number.isFinite(spreadBps) || spreadBps <= maxSpreadBps;
    ageOk = !Number.isFinite(maxQuoteAgeMs) || !Number.isFinite(ageMs) || ageMs <= maxQuoteAgeMs;
    if (spreadOk && ageOk) {
      effective = mid;
      source = "mid";
    }
  }

  return {
    effectivePrice: Number.isFinite(effective) ? effective : null,
    source,
    bid,
    ask,
    spreadBps,
    quoteAgeMs: ageMs,
    spreadOk,
    ageOk,
  };
}

module.exports = { getEffectivePrice };
