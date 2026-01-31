const { env } = require("../config");
const { getDb } = require("../db");
const { logger } = require("../logger");
const {
  ensureIndexes,
  ttlDaysForInterval,
  collectionName,
} = require("./candleStore");

function _parseIntervalFromCollection(name) {
  const prefix = env.CANDLE_COLLECTION_PREFIX || "candles_";
  if (!name || typeof name !== "string") return null;
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  if (!rest.endsWith("m")) return null;
  const num = Number(rest.slice(0, -1));
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

async function listCandleCollections() {
  const db = getDb();
  const cols = await db.listCollections({}, { nameOnly: true }).toArray();
  const out = [];
  for (const c of cols || []) {
    const name = c?.name;
    const intervalMin = _parseIntervalFromCollection(name);
    if (!intervalMin) continue;
    out.push({ name, intervalMin });
  }
  out.sort((a, b) => a.intervalMin - b.intervalMin);
  return out;
}

async function describeRetention() {
  const enabled = String(env.CANDLE_TTL_ENABLED || "false") === "true";
  const defDays = Number(env.CANDLE_TTL_DEFAULT_DAYS || 90);
  const mapStr = String(env.CANDLE_TTL_MAP || "");
  const cols = await listCandleCollections();

  const db = getDb();
  const details = [];
  for (const c of cols) {
    const ttlDays = ttlDaysForInterval(c.intervalMin);
    const wantSecs =
      ttlDays && Number.isFinite(ttlDays) ? Math.round(ttlDays * 86400) : null;

    let ttlIndex = null;
    try {
      const idxs = await db.collection(c.name).indexes();
      const tsAsc = (idxs || []).find((i) => i?.key && i.key.ts === 1);
      if (tsAsc) {
        ttlIndex = {
          name: tsAsc.name,
          expireAfterSeconds:
            tsAsc.expireAfterSeconds != null
              ? Number(tsAsc.expireAfterSeconds)
              : null,
        };
      }
    } catch {
      ttlIndex = null;
    }

    details.push({
      intervalMin: c.intervalMin,
      collection: c.name,
      ttlEnabled: enabled,
      desiredDays: ttlDays,
      desiredExpireAfterSeconds: wantSecs,
      currentTtlIndex: ttlIndex,
    });
  }

  return {
    ok: true,
    config: {
      enabled,
      defaultDays: defDays,
      map: mapStr,
      prefix: env.CANDLE_COLLECTION_PREFIX || "candles_",
    },
    collections: details,
  };
}

async function ensureRetentionIndexes(opts = {}) {
  const enabled = String(env.CANDLE_TTL_ENABLED || "false") === "true";
  if (!enabled) return { ok: true, enabled: false, ensured: 0 };

  const log = opts.log ?? String(env.CANDLE_TTL_LOG || "true") === "true";

  const cols = await listCandleCollections();

  // Also ensure for configured intervals even if the collection hasn't been created yet.
  const intervals = (env.CANDLE_INTERVALS || "1,3")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  const allIntervals = new Set([
    ...cols.map((c) => c.intervalMin),
    ...intervals,
  ]);

  let ensured = 0;
  for (const intervalMin of Array.from(allIntervals).sort((a, b) => a - b)) {
    try {
      await ensureIndexes(intervalMin);
      ensured++;
      if (log) {
        logger.info(
          {
            intervalMin,
            collection: collectionName(intervalMin),
            ttlDays: ttlDaysForInterval(intervalMin),
          },
          "[retention] ensured TTL indexes",
        );
      }
    } catch (e) {
      logger.warn(
        { intervalMin, e: e?.message || String(e) },
        "[retention] ensureIndexes failed",
      );
    }
  }

  return { ok: true, enabled: true, ensured };
}

module.exports = {
  listCandleCollections,
  describeRetention,
  ensureRetentionIndexes,
};
