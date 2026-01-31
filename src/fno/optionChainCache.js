const crypto = require("crypto");
const { logger } = require("../logger");
const { getQuoteGuarded } = require("../kite/quoteGuard");

// Very small in-memory cache (TTL ms). Designed for intraday routing:
// - cache quote snapshots for a small strike band around ATM
// - expose last snapshot + last pick for /admin inspection

const _cache = new Map(); // key -> { ts, ttlMs, data }
const _lastChainByKey = new Map(); // keyShort -> chain snapshot
const _lastChainByUnderlying = new Map(); // underlying|optType -> last chain snapshot
const _lastPickByUnderlying = new Map(); // underlying -> last pick object

function _now() {
  return Date.now();
}

function _hash(str) {
  return crypto
    .createHash("sha1")
    .update(String(str || ""))
    .digest("hex")
    .slice(0, 10);
}

function makeCacheKey({
  underlying,
  optType,
  expiryISO,
  exchanges,
  candidateTokens,
}) {
  const ex = (exchanges || []).join(",");
  const toks = (candidateTokens || []).slice(0, 64).join(",");
  return `${String(underlying || "").toUpperCase()}|${String(optType || "").toUpperCase()}|${String(expiryISO || "").slice(0, 10)}|${ex}|${_hash(toks)}`;
}

async function getOptionChainSnapshot({
  kite,
  underlying,
  optType,
  expiryISO,
  exchanges,
  candidates,
  ttlMs,
}) {
  const candidateTokens = (candidates || [])
    .map((r) => Number(r.instrument_token))
    .filter((n) => Number.isFinite(n));
  const key = makeCacheKey({
    underlying,
    optType,
    expiryISO,
    exchanges,
    candidateTokens,
  });

  const cached = _cache.get(key);
  const now = _now();
  if (cached && now - cached.ts <= cached.ttlMs) {
    return { ok: true, fromCache: true, key, snapshot: cached.data };
  }

  const keys = (candidates || []).map((r) => {
    const ex = String(r.exchange || "NFO").toUpperCase();
    return `${ex}:${r.tradingsymbol}`;
  });

  let quotes = {};
  try {
    quotes = keys.length
      ? await getQuoteGuarded(kite, keys, {
          label: `[opt-chain] ${String(underlying || "").toUpperCase()} ${String(optType || "").toUpperCase()}`,
        })
      : {};
  } catch (e) {
    logger.warn(
      { e: e?.message || String(e), underlying, optType },
      "[opt-chain] guarded getQuote failed",
    );
    quotes = {};
  }

  const rows = (candidates || []).map((r) => {
    const qk = `${String(r.exchange || "NFO").toUpperCase()}:${r.tradingsymbol}`;
    const q = quotes?.[qk];

    const ltp = Number(q?.last_price);

    const buyP = Number(q?.depth?.buy?.[0]?.price);
    const sellP = Number(q?.depth?.sell?.[0]?.price);
    const buyQ = Number(q?.depth?.buy?.[0]?.quantity);
    const sellQ = Number(q?.depth?.sell?.[0]?.quantity);

    const mid =
      Number.isFinite(buyP) && Number.isFinite(sellP)
        ? (buyP + sellP) / 2
        : null;
    const bps =
      mid && mid > 0 && Number.isFinite(buyP) && Number.isFinite(sellP)
        ? ((sellP - buyP) / mid) * 10000
        : null;

    const depthQty =
      (Number.isFinite(buyQ) ? buyQ : 0) + (Number.isFinite(sellQ) ? sellQ : 0);

    // Zerodha quote payloads vary by segment. Keep defensive fallbacks.
    const volume = Number(q?.volume ?? q?.volume_traded ?? q?.oi_day_high ?? 0);
    const oi = Number(q?.oi ?? 0);

    return {
      instrument_token: Number(r.instrument_token),
      tradingsymbol: r.tradingsymbol,
      exchange: r.exchange,
      segment: r.segment,
      expiry: r.expiry,
      strike: Number(r.strike),
      lot_size: Number(r.lot_size || 1),
      tick_size: Number(r.tick_size || 0.05),
      ltp: Number.isFinite(ltp) ? ltp : null,
      bid: Number.isFinite(buyP) ? buyP : null,
      ask: Number.isFinite(sellP) ? sellP : null,
      spread_bps: Number.isFinite(bps) ? bps : null,
      depth_qty_top: depthQty,
      volume: Number.isFinite(volume) ? volume : 0,
      oi: Number.isFinite(oi) ? oi : 0,
    };
  });

  const snapshot = {
    ts: now,
    ttlMs: Number(ttlMs || 1500),
    underlying: String(underlying || "").toUpperCase(),
    optType: String(optType || "").toUpperCase(),
    expiryISO: String(expiryISO || "").slice(0, 10),
    exchanges: (exchanges || []).slice(),
    count: rows.length,
    rows,
  };

  const ttl = Math.max(250, Number(ttlMs || 1500));
  _cache.set(key, { ts: now, ttlMs: ttl, data: snapshot });

  const keyShort = `${snapshot.underlying}|${snapshot.optType}|${snapshot.expiryISO}`;
  _lastChainByKey.set(keyShort, snapshot);
  _lastChainByUnderlying.set(
    `${snapshot.underlying}|${snapshot.optType}`,
    snapshot,
  );

  // Trim cache
  if (_cache.size > 50) {
    const entries = Array.from(_cache.entries()).sort(
      (a, b) => a[1].ts - b[1].ts,
    );
    for (let i = 0; i < Math.max(10, entries.length - 40); i++) {
      _cache.delete(entries[i][0]);
    }
  }

  return { ok: true, fromCache: false, key, snapshot };
}

function setLastOptionPick(underlying, pick) {
  const u = String(underlying || "").toUpperCase();
  if (!u) return;
  _lastPickByUnderlying.set(u, { ts: Date.now(), ...pick });
  if (_lastPickByUnderlying.size > 50) {
    const entries = Array.from(_lastPickByUnderlying.entries()).sort(
      (a, b) => (a[1]?.ts || 0) - (b[1]?.ts || 0),
    );
    for (let i = 0; i < Math.max(10, entries.length - 40); i++) {
      _lastPickByUnderlying.delete(entries[i][0]);
    }
  }
}

function getLastOptionPick(underlying) {
  const u = String(underlying || "").toUpperCase();
  return u ? _lastPickByUnderlying.get(u) || null : null;
}

function getLastOptionPickAll() {
  const out = {};
  for (const [k, v] of _lastPickByUnderlying.entries()) out[k] = v;
  return out;
}

function getLastChain({ underlying, optType, expiryISO } = {}) {
  const u = String(underlying || "").toUpperCase();
  const t = String(optType || "").toUpperCase();
  const e = expiryISO ? String(expiryISO).slice(0, 10) : null;

  if (u && t && e) {
    return _lastChainByKey.get(`${u}|${t}|${e}`) || null;
  }
  if (u && t) {
    return _lastChainByUnderlying.get(`${u}|${t}`) || null;
  }
  return null;
}

function getCacheStats() {
  return {
    cacheEntries: _cache.size,
    lastChains: _lastChainByKey.size,
    lastPicks: _lastPickByUnderlying.size,
  };
}

module.exports = {
  getOptionChainSnapshot,
  getLastChain,
  setLastOptionPick,
  getLastOptionPick,
  getLastOptionPickAll,
  getCacheStats,
};
