const crypto = require("crypto");
const { DateTime } = require("luxon");
const { logger } = require("../logger");
const {
  getQuoteGuarded,
  isQuoteGuardBreakerOpen,
  getQuoteGuardStats,
} = require("../kite/quoteGuard");
const { computeGreeksFromMarket } = require("./greeks");
const { normalizeTickSize } = require("../utils/tickSize");

// Very small in-memory cache (TTL ms). Designed for intraday routing:
// - cache quote snapshots for a small strike band around ATM
// - expose last snapshot + last pick for /admin inspection

const _cache = new Map(); // key -> { ts, ttlMs, data }
const _lastChainByKey = new Map(); // keyShort -> chain snapshot
const _lastChainByUnderlying = new Map(); // underlying|optType -> last chain snapshot
const _lastPickByUnderlying = new Map(); // underlying -> last pick object

// For microstructure + greeks trend detection (spread bps / iv / oi change)
const _lastRowBySymbol = new Map(); // qk -> { ts, spread_bps, iv, oi, bid, ask, volume }

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

function _tz(env) {
  return env?.CANDLE_TZ || "Asia/Kolkata";
}

function _expiryTimeYears(expiryISO, env, nowMs) {
  const s = String(expiryISO || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;

  // For Indian index options, expiry is effectively end of session.
  const exp = DateTime.fromISO(s, { zone: _tz(env) }).set({
    hour: 15,
    minute: 30,
    second: 0,
    millisecond: 0,
  });

  if (!exp.isValid) return null;
  const now = DateTime.fromMillis(nowMs || Date.now(), { zone: _tz(env) });

  const diffSec = exp.diff(now, "seconds").seconds;
  // Clamp to small positive to avoid div-by-zero / negative T.
  const sec = Math.max(60, Number(diffSec || 0));
  return sec / (365 * 24 * 60 * 60);
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
  env,
  underlying,
  optType,
  expiryISO,
  exchanges,
  candidates,
  ttlMs,
  underlyingLtp,
  nowMs,
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
  const now = Number(nowMs || _now());
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

  const S = Number(underlyingLtp);
  const useGreeks = Number.isFinite(S) && S > 0;
  const r = Number(env?.OPT_RISK_FREE_RATE ?? 0.06);
  const T = _expiryTimeYears(expiryISO, env, now);
  const isCall = String(optType || "").toUpperCase() === "CE";

  const rows = (candidates || []).map((r0) => {
    const rTok = Number(r0.instrument_token);
    const qk = `${String(r0.exchange || "NFO").toUpperCase()}:${r0.tradingsymbol}`;
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
    const volume = Number(q?.volume ?? q?.volume_traded ?? 0);
    const oi = Number(q?.oi ?? 0);

    // trend deltas
    const prev = _lastRowBySymbol.get(qk) || null;
    const oiChange =
      Number.isFinite(oi) && Number.isFinite(prev?.oi) ? oi - prev.oi : null;
    const spreadBpsChange =
      Number.isFinite(bps) && Number.isFinite(prev?.spread_bps)
        ? bps - prev.spread_bps
        : null;
    const spreadTrendBad =
      Number.isFinite(spreadBpsChange) && spreadBpsChange > 0 ? spreadBpsChange : 0;

    const volVelocity =
      Number.isFinite(volume) && Number.isFinite(prev?.volume) && now > Number(prev?.ts || 0)
        ? Math.max(0, ((volume - prev.volume) / Math.max(1, now - prev.ts)) * 1000)
        : null;

    const bookFlicker =
      Number.isFinite(prev?.bid) && Number.isFinite(prev?.ask) && Number.isFinite(buyP) && Number.isFinite(sellP)
        ? (Math.abs(prev.bid - buyP) > 0 ? 1 : 0) + (Math.abs(prev.ask - sellP) > 0 ? 1 : 0)
        : 0;

    const impactCostBps =
      Number.isFinite(mid) && mid > 0
        ? (((Number.isFinite(sellP) ? sellP : mid) - mid) / mid) * 10000
        : null;

    // greeks/IV (approx) from mid/ltp
    let greeks = null;
    const K = Number(r0.strike);
    const px =
      Number.isFinite(mid) && mid > 0
        ? mid
        : Number.isFinite(ltp) && ltp > 0
          ? ltp
          : null;
    if (
      useGreeks &&
      Number.isFinite(K) &&
      K > 0 &&
      Number.isFinite(T) &&
      T > 0 &&
      Number.isFinite(px) &&
      px > 0
    ) {
      greeks = computeGreeksFromMarket({
        S,
        K,
        r: Number.isFinite(r) ? r : 0.06,
        T,
        isCall,
        marketPrice: px,
      });
    }

    const iv = Number.isFinite(greeks?.iv) ? greeks.iv : null; // decimal (0.18)
    const ivPts = Number.isFinite(iv) ? iv * 100 : null; // points (18)
    const ivChangePts =
      Number.isFinite(iv) && Number.isFinite(prev?.iv)
        ? (iv - prev.iv) * 100
        : null;

    const row = {
      instrument_token: Number.isFinite(rTok) ? rTok : null,
      tradingsymbol: r0.tradingsymbol,
      exchange: r0.exchange,
      segment: r0.segment,
      expiry: r0.expiry,
      strike: Number(K),
      lot_size: Number(r0.lot_size || 1),
      tick_size: normalizeTickSize(r0.tick_size),
      ltp: Number.isFinite(ltp) ? ltp : null,
      bid: Number.isFinite(buyP) ? buyP : null,
      ask: Number.isFinite(sellP) ? sellP : null,
      mid: Number.isFinite(mid) ? mid : null,
      spread_bps: Number.isFinite(bps) ? bps : null,
      spread_bps_change: Number.isFinite(spreadBpsChange)
        ? spreadBpsChange
        : null,
      depth_qty_top: depthQty,
      volume: Number.isFinite(volume) ? volume : 0,
      oi: Number.isFinite(oi) ? oi : 0,
      oi_change: Number.isFinite(oiChange) ? oiChange : null,
      vol_velocity: Number.isFinite(volVelocity) ? volVelocity : null,
      book_flicker: Number.isFinite(bookFlicker) ? bookFlicker : 0,
      impact_cost_bps: Number.isFinite(impactCostBps) ? impactCostBps : null,

      // Greeks (may be null if inputs are insufficient)
      iv: Number.isFinite(iv) ? iv : null,
      iv_pts: Number.isFinite(ivPts) ? ivPts : null,
      iv_change_pts: Number.isFinite(ivChangePts) ? ivChangePts : null,
      delta: Number.isFinite(greeks?.delta) ? greeks.delta : null,
      gamma: Number.isFinite(greeks?.gamma) ? greeks.gamma : null,
      vega_1pct: Number.isFinite(greeks?.vegaPer1Pct)
        ? greeks.vegaPer1Pct
        : null,
      theta_per_day: Number.isFinite(greeks?.thetaPerDay)
        ? greeks.thetaPerDay
        : null,
    };

    const oiScore = Number.isFinite(oi) && oi > 0 ? Math.min(20, Math.log(oi + 1)) : 0;
    const volScore = Number.isFinite(volVelocity) ? Math.min(20, volVelocity / 5) : 0;
    const spreadPenalty = Number.isFinite(bps) ? Math.min(35, Math.max(0, bps / 2)) : 35;
    const flickerPenalty = Math.min(20, Number(bookFlicker || 0) * 5 + Math.max(0, spreadTrendBad / 3));
    const impactPenalty = Number.isFinite(impactCostBps) ? Math.min(15, Math.max(0, impactCostBps / 2)) : 10;
    row.health_score = Math.max(0, Math.min(100, 55 + oiScore + volScore - spreadPenalty - flickerPenalty - impactPenalty));

    // Update trend cache (even if greeks missing, keep spread/oi)
    _lastRowBySymbol.set(qk, {
      ts: now,
      spread_bps: Number.isFinite(bps) ? bps : null,
      iv: Number.isFinite(iv) ? iv : null,
      oi: Number.isFinite(oi) ? oi : null,
      bid: Number.isFinite(buyP) ? buyP : null,
      ask: Number.isFinite(sellP) ? sellP : null,
      volume: Number.isFinite(volume) ? volume : null,
    });

    return row;
  });

  const snapshot = {
    ts: now,
    ttlMs: Number(ttlMs || 1500),
    underlying: String(underlying || "").toUpperCase(),
    optType: String(optType || "").toUpperCase(),
    expiryISO: String(expiryISO || "").slice(0, 10),
    exchanges: (exchanges || []).slice(),
    meta: {
      underlyingLtp: Number.isFinite(S) ? S : null,
      r: Number.isFinite(r) ? r : null,
      T,
      quoteGuard: {
        breakerOpen:
          typeof isQuoteGuardBreakerOpen === "function"
            ? Boolean(isQuoteGuardBreakerOpen())
            : false,
        breakerOpenUntil:
          (typeof getQuoteGuardStats === "function"
            ? getQuoteGuardStats()?.breakerOpenUntil
            : null) || null,
      },
    },
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

  // Trim row trend cache
  if (_lastRowBySymbol.size > 3000) {
    const entries = Array.from(_lastRowBySymbol.entries()).sort(
      (a, b) => (a[1]?.ts || 0) - (b[1]?.ts || 0),
    );
    for (let i = 0; i < Math.max(500, entries.length - 2500); i++) {
      _lastRowBySymbol.delete(entries[i][0]);
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
    trendRows: _lastRowBySymbol.size,
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
