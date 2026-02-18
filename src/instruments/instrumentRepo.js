const { env } = require("../config");
const { normalizeTickSize } = require("../utils/tickSize");
const { logger } = require("../logger");
const { getDb } = require("../db");
const { alert } = require("../alerts/alertService");

const COLLECTION = "instruments_cache";

// In-memory instruments dump cache (per exchange). Prevents repeated downloads.
// NOTE: instruments dumps are large; keep TTL conservative.
const dumpCache = new Map(); // ex -> { fetchedAt:number, rows:Array }
const tokenCache = new Map(); // token -> instrument doc

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const s = String(x || "").trim();
    if (!s) continue;
    const k = s.toUpperCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function parseCsvList(v) {
  return uniq(
    String(v || "")
      .split(",")
      .map((s) => String(s).trim())
      .filter(Boolean),
  );
}

async function getInstrumentsDump(kite, exchange) {
  const ex = String(exchange || env.DEFAULT_EXCHANGE || "NSE").toUpperCase();
  const ttlSec = Number(env.INSTRUMENTS_DUMP_TTL_SEC || 3600);
  const now = Date.now();
  const cached = dumpCache.get(ex);
  if (cached && now - cached.fetchedAt < ttlSec * 1000) return cached.rows;
  if (typeof kite.getInstruments !== "function") {
    throw new Error("[instruments] kite.getInstruments unavailable");
  }
  const rows = await kite.getInstruments(ex);
  dumpCache.set(ex, { fetchedAt: now, rows });
  return rows;
}

async function upsertInstrument(doc) {
  const db = getDb();
  await db
    .collection(COLLECTION)
    .updateOne(
      { instrument_token: doc.instrument_token },
      { $set: { ...doc, updatedAt: new Date() } },
      { upsert: true },
    );
}

async function getInstrumentByToken(instrument_token) {
  const db = getDb();
  return db
    .collection(COLLECTION)
    .findOne({ instrument_token: Number(instrument_token) });
}

function isInstrumentCacheStale(doc) {
  const maxAgeHours = Number(env.INSTRUMENT_CACHE_MAX_AGE_HOURS || 0);
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) return false;
  const updatedAt = doc?.updatedAt ? new Date(doc.updatedAt).getTime() : 0;
  if (!updatedAt || Number.isNaN(updatedAt)) return true;
  const ageMs = Date.now() - updatedAt;
  return ageMs > maxAgeHours * 60 * 60 * 1000;
}

async function ensureInstrument(kite, instrument_token) {
  const tok = Number(instrument_token);
  const mem = tokenCache.get(tok);
  if (mem && !isInstrumentCacheStale(mem)) return mem;
  let doc = await getInstrumentByToken(tok);
  if (doc && !isInstrumentCacheStale(doc)) {
    tokenCache.set(tok, doc);
    return doc;
  }
  if (doc) {
    logger.info(
      { tok },
      "[instruments] cache stale; refreshing instrument metadata",
    );
  }

  // Search token across a small ordered exchange list.
  const exchanges = uniq([
    env.DEFAULT_EXCHANGE || "NSE",
    ...parseCsvList(env.FNO_EXCHANGES || ""),
    "NSE",
    "NFO",
    "BSE",
    "BFO",
  ]);

  logger.warn(
    { tok, exchanges },
    "[instruments] missing in cache; scanning instruments dumps (slow)",
  );

  let row = null;
  let usedEx = null;
  for (const ex of exchanges) {
    try {
      const instruments = await getInstrumentsDump(kite, ex);
      row = instruments.find((x) => Number(x.instrument_token) === tok);
      if (row) {
        usedEx = ex;
        break;
      }
    } catch (e) {
      logger.warn({ ex, tok, e: e.message }, "[instruments] dump fetch failed");
    }
  }

  if (!row) {
    if (doc) {
      logger.warn(
        { tok },
        "[instruments] refresh failed; returning cached instrument metadata",
      );
      return doc;
    }
    throw new Error(
      `[instruments] token not found in instruments dumps: ${tok} (checked ${exchanges.join(
        ",",
      )})`,
    );
  }

  doc = {
    instrument_token: tok,
    exchange: row.exchange || usedEx,
    tradingsymbol: row.tradingsymbol,
    tick_size: normalizeTickSize(row.tick_size),
    lot_size: Number(row.lot_size || 1),
    freeze_qty: Number(row.freeze_qty || row.freeze_quantity || 0) || null,
    segment: row.segment,
    instrument_type: row.instrument_type,
    name: row.name,
    expiry: row.expiry,
    strike: row.strike,
  };
  await upsertInstrument(doc);
  tokenCache.set(tok, doc);
  return doc;
}

async function getInstrumentBySymbol({ tradingsymbol, exchange }) {
  const db = getDb();
  const q = { tradingsymbol: String(tradingsymbol).toUpperCase().trim() };
  if (exchange) q.exchange = String(exchange).toUpperCase().trim();
  return db.collection(COLLECTION).findOne(q);
}

/**
 * Resolve a symbol like:
 * - "RELIANCE" (uses DEFAULT_EXCHANGE)
 * - "NSE:RELIANCE"
 */
function parseSymbol(sym) {
  const s = String(sym || "").trim();
  if (!s) return null;
  const parts = s.split(":");
  if (parts.length === 2) {
    return {
      exchange: parts[0].toUpperCase(),
      tradingsymbol: parts[1].toUpperCase(),
    };
  }
  return {
    exchange: (env.DEFAULT_EXCHANGE || "NSE").toUpperCase(),
    tradingsymbol: s.toUpperCase(),
  };
}

async function ensureInstrumentBySymbol(kite, symbol) {
  const parsed = parseSymbol(symbol);
  if (!parsed) throw new Error("[instruments] empty symbol");
  let doc = await getInstrumentBySymbol(parsed);
  if (doc && !isInstrumentCacheStale(doc)) return doc;
  if (doc) {
    logger.info(
      { symbol: parsed.tradingsymbol, exchange: parsed.exchange },
      "[instruments] cache stale; refreshing instrument metadata",
    );
  }

  const ex = parsed.exchange || env.DEFAULT_EXCHANGE || "NSE";
  logger.warn(
    { symbol, ex },
    "[instruments] symbol missing in cache; scanning instruments dump (slow)",
  );
  const instruments = await getInstrumentsDump(kite, ex);

  const row = instruments.find(
    (x) =>
      String(x.tradingsymbol).toUpperCase() === parsed.tradingsymbol &&
      String(x.exchange).toUpperCase() === ex.toUpperCase(),
  );

  if (!row) {
    if (doc) {
      logger.warn(
        { symbol: parsed.tradingsymbol, exchange: ex },
        "[instruments] refresh failed; returning cached instrument metadata",
      );
      return doc;
    }
    throw new Error(
      `[instruments] tradingsymbol not found in ${ex} instruments dump: ${parsed.tradingsymbol} (check your SUBSCRIBE_SYMBOLS; for Mazagon Dock, Zerodha symbol is MAZDOCK)`,
    );
  }

  doc = {
    instrument_token: Number(row.instrument_token),
    exchange: row.exchange,
    tradingsymbol: row.tradingsymbol,
    tick_size: normalizeTickSize(row.tick_size),
    lot_size: Number(row.lot_size || 1),
    freeze_qty: Number(row.freeze_qty || row.freeze_quantity || 0) || null,
    segment: row.segment,
    instrument_type: row.instrument_type,
    name: row.name,
    expiry: row.expiry,
    strike: row.strike,
  };
  await upsertInstrument(doc);
  tokenCache.set(Number(doc.instrument_token), doc);
  return doc;
}

async function preloadInstrumentsByToken(kite, tokens = []) {
  const wants = uniq(tokens)
    .map((t) => Number(t))
    .filter((t) => Number.isFinite(t) && t > 0);
  if (!wants.length || typeof kite?.getInstruments !== "function") return;

  const missing = wants.filter((t) => !tokenCache.has(t));
  if (!missing.length) return;

  const exchanges = uniq([
    env.DEFAULT_EXCHANGE || "NSE",
    ...parseCsvList(env.FNO_EXCHANGES || ""),
    "NSE",
    "NFO",
    "BSE",
    "BFO",
  ]);

  const missingSet = new Set(missing);
  for (const ex of exchanges) {
    if (!missingSet.size) break;
    try {
      const instruments = await getInstrumentsDump(kite, ex);
      for (const row of instruments || []) {
        const tok = Number(row.instrument_token);
        if (!missingSet.has(tok)) continue;
        const doc = {
          instrument_token: tok,
          exchange: row.exchange || ex,
          tradingsymbol: row.tradingsymbol,
          tick_size: normalizeTickSize(row.tick_size),
          lot_size: Number(row.lot_size || 1),
          freeze_qty: Number(row.freeze_qty || row.freeze_quantity || 0) || null,
          segment: row.segment,
          instrument_type: row.instrument_type,
          name: row.name,
          expiry: row.expiry,
          strike: row.strike,
          updatedAt: new Date(),
        };
        await upsertInstrument(doc);
        tokenCache.set(tok, doc);
        missingSet.delete(tok);
        if (!missingSet.size) break;
      }
    } catch (e) {
      logger.warn({ ex, e: e.message }, "[instruments] preload failed");
    }
  }
}

async function resolveSubscribeTokens(
  kite,
  { tokens = [], symbols = [] } = {},
) {
  const out = new Set();
  for (const t of tokens || []) {
    const n = Number(t);
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  for (const sym of symbols || []) {
    try {
      const doc = await ensureInstrumentBySymbol(kite, sym);
      out.add(Number(doc.instrument_token));
    } catch (e) {
      const msg = e?.message || String(e);
      logger.error(
        { sym, msg },
        "[instruments] failed to resolve subscribe symbol; skipping",
      );
      alert("warn", "⚠️ Subscribe symbol skipped", {
        symbol: String(sym),
        error: msg,
      }).catch(() => {});
      if (String(env.STRICT_SUBSCRIBE_SYMBOLS || "").toLowerCase() === "true")
        throw e;
    }
  }
  return Array.from(out);
}

module.exports = {
  upsertInstrument,
  getInstrumentByToken,
  getInstrumentBySymbol,
  ensureInstrument,
  ensureInstrumentBySymbol,
  preloadInstrumentsByToken,
  resolveSubscribeTokens,
  parseSymbol,
  getInstrumentsDump,
  parseCsvList,
  uniq,
  COLLECTION,
};
