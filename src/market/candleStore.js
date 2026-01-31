const { env } = require("../config");
const { getDb } = require("../db");

function collectionName(intervalMin) {
  const prefix = env.CANDLE_COLLECTION_PREFIX || "candles_";
  return `${prefix}${intervalMin}m`;
}

// ---- Retention / TTL helpers ----
let _ttlMapCacheKey = null;
let _ttlMapCache = new Map();

function _parseTtlMap(mapStr) {
  // Format: "1:30,3:60,5:90" => days per intervalMin
  const out = new Map();
  if (!mapStr) return out;
  const parts = String(mapStr)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const p of parts) {
    const [k, v] = p.split(":").map((x) => String(x || "").trim());
    const km = Number(k);
    const days = Number(v);
    if (Number.isFinite(km) && km > 0 && Number.isFinite(days) && days > 0) {
      out.set(km, days);
    }
  }
  return out;
}

function _getTtlMap() {
  const key = String(env.CANDLE_TTL_MAP || "");
  if (key !== _ttlMapCacheKey) {
    _ttlMapCacheKey = key;
    _ttlMapCache = _parseTtlMap(key);
  }
  return _ttlMapCache;
}

function ttlDaysForInterval(intervalMin) {
  const enabled = String(env.CANDLE_TTL_ENABLED || "false") === "true";
  if (!enabled) return null;

  const m = _getTtlMap();
  if (m.has(Number(intervalMin))) return Number(m.get(Number(intervalMin)));

  const defDays = Number(env.CANDLE_TTL_DEFAULT_DAYS || 90);
  if (!Number.isFinite(defDays) || defDays <= 0) return null;
  return defDays;
}

async function ensureTtlIndex(col, expireAfterSeconds) {
  const desired = Number(expireAfterSeconds);
  if (!Number.isFinite(desired) || desired <= 0) return;

  // Mongo cannot "update" expireAfterSeconds on an existing index.
  // If expireAfterSeconds changed, we must drop and recreate the TTL index.
  let indexes = [];
  try {
    indexes = await col.indexes();
  } catch {
    indexes = [];
  }

  // Any ts:1 index conflicts with TTL index (even if non-TTL).
  const tsAsc = indexes.find((i) => i?.key && i.key.ts === 1);
  if (tsAsc) {
    const current = Number(tsAsc.expireAfterSeconds || 0);
    const hasTTL = Number.isFinite(current) && current > 0;

    // Already correct TTL index → keep.
    if (hasTTL && current === desired) return;

    try {
      await col.dropIndex(tsAsc.name);
    } catch {}
  }

  await col.createIndex(
    { ts: 1 },
    { expireAfterSeconds: desired, name: "ttl_ts" },
  );
}

async function ensureIndexes(intervalMin) {
  const db = getDb();
  const col = db.collection(collectionName(intervalMin));

  await col.createIndex({ instrument_token: 1, ts: 1 }, { unique: true });
  await col.createIndex({ ts: -1 });

  // Retention: TTL on candle timestamps (ts is a Date).
  const ttlDays = ttlDaysForInterval(intervalMin);
  if (ttlDays) {
    const expireAfterSeconds = Math.round(ttlDays * 24 * 60 * 60);
    await ensureTtlIndex(col, expireAfterSeconds);
  }
}

async function upsertCandle(c) {
  const db = getDb();
  const col = db.collection(collectionName(c.interval_min));
  await col.updateOne(
    { instrument_token: c.instrument_token, ts: c.ts },
    { $set: { ...c, updatedAt: new Date() } },
    { upsert: true },
  );
}

async function insertManyCandles(intervalMin, candles) {
  if (!candles.length) return;
  const db = getDb();
  const col = db.collection(collectionName(intervalMin));
  const ops = candles.map((c) => ({
    updateOne: {
      filter: { instrument_token: c.instrument_token, ts: c.ts },
      update: { $set: { ...c, updatedAt: new Date() } },
      upsert: true,
    },
  }));
  await col.bulkWrite(ops, { ordered: false });
}

async function getRecentCandles(instrument_token, intervalMin, limit = 250) {
  const db = getDb();
  const col = db.collection(collectionName(intervalMin));
  const rows = await col
    .find({ instrument_token: Number(instrument_token) })
    .sort({ ts: -1 })
    .limit(limit)
    .toArray();
  return rows.reverse();
}

module.exports = {
  collectionName,
  ttlDaysForInterval,
  ensureIndexes,
  upsertCandle,
  insertManyCandles,
  getRecentCandles,
};
