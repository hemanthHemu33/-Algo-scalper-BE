const { DateTime } = require("luxon");
const { env } = require("../config");
const { logger } = require("../logger");
const {
  getInstrumentsDump,
  parseCsvList,
  uniq,
} = require("../instruments/instrumentRepo");

let lastUniverse = null;

function parseDate(v) {
  if (!v) return null;
  try {
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function todayYMD() {
  const tz = env.CANDLE_TZ || "Asia/Kolkata";
  return DateTime.now().setZone(tz).toFormat("yyyy-MM-dd");
}

function isEnabled() {
  return String(env.FNO_ENABLED || "false").toLowerCase() === "true";
}

function getLastFnoUniverse() {
  return lastUniverse;
}

function bestRowByNearestExpiry(rows) {
  const today = parseDate(todayYMD());
  let best = null;
  let bestExp = null;
  for (const r of rows || []) {
    const exp = parseDate(r.expiry);
    if (!exp) continue;
    // choose expiry today or later
    if (today && exp < today) continue;
    if (!bestExp || exp < bestExp) {
      bestExp = exp;
      best = r;
    }
  }
  return best;
}

async function pickNearestFuture(kite, underlying, exchanges) {
  const exList = uniq(exchanges);
  const u = String(underlying || "").toUpperCase();

  for (const ex of exList) {
    const rows = await getInstrumentsDump(kite, ex);
    const futs = (rows || []).filter((r) => {
      const name = String(r.name || "").toUpperCase();
      const seg = String(r.segment || "").toUpperCase();
      const it = String(r.instrument_type || "").toUpperCase();
      return name === u && (it === "FUT" || seg.endsWith("-FUT"));
    });

    const best = bestRowByNearestExpiry(futs);
    if (best) {
      return {
        underlying: u,
        instrument_token: Number(best.instrument_token),
        exchange: best.exchange || ex,
        tradingsymbol: best.tradingsymbol,
        segment: best.segment,
        expiry: best.expiry,
        lot_size: Number(best.lot_size || 1),
        tick_size: Number(best.tick_size || 0.05),
      };
    }
  }
  return null;
}

async function pickSpotIndexToken(kite, underlying) {
  // Zerodha index tokens live in NSE instruments dump (instrument_type: INDEX)
  // This is optional; OPT_UNDERLYING_SOURCE=FUT is the safest default.
  const u = String(underlying || "").toUpperCase();
  const rows = await getInstrumentsDump(kite, "NSE");

  const candidates = (rows || []).filter((r) => {
    const it = String(r.instrument_type || "").toUpperCase();
    if (it !== "INDEX") return false;

    const ts = String(r.tradingsymbol || "").toUpperCase();
    const name = String(r.name || "").toUpperCase();

    // common Zerodha index symbols
    if (u === "NIFTY") return ts.includes("NIFTY") && ts.includes("50");
    if (u === "BANKNIFTY") return ts.includes("NIFTY") && ts.includes("BANK");
    if (u === "SENSEX") return ts.includes("SENSEX") || name.includes("SENSEX");

    return ts.includes(u) || name.includes(u);
  });

  const best = candidates[0] || null;
  if (!best) return null;
  return {
    underlying: u,
    instrument_token: Number(best.instrument_token),
    exchange: best.exchange || "NSE",
    tradingsymbol: best.tradingsymbol,
    segment: best.segment,
    expiry: null,
    lot_size: 1,
    tick_size: Number(best.tick_size || 0.05),
  };
}

async function buildFnoUniverse({ kite }) {
  if (!isEnabled()) {
    lastUniverse = {
      ok: true,
      enabled: false,
      universe: null,
      builtAt: new Date().toISOString(),
    };
    return lastUniverse;
  }

  const mode = String(env.FNO_MODE || "FUT").toUpperCase();
  let underlyings = parseCsvList(env.FNO_UNDERLYINGS || "");
  if (env.FNO_SINGLE_UNDERLYING_ENABLED) {
    const only = String(env.FNO_SINGLE_UNDERLYING_SYMBOL || "").trim();
    if (only) underlyings = [only];
  }
  underlyings = uniq(underlyings);
  const exchanges = parseCsvList(env.FNO_EXCHANGES || "NFO,BFO");

  const contracts = {};
  const tokens = [];
  const symbols = [];

  for (const u of underlyings) {
    let picked = null;

    if (mode === "FUT") {
      picked = await pickNearestFuture(kite, u, exchanges);
    } else if (mode === "OPT") {
      const src = String(env.OPT_UNDERLYING_SOURCE || "FUT").toUpperCase();
      picked =
        src === "SPOT"
          ? await pickSpotIndexToken(kite, u)
          : await pickNearestFuture(kite, u, exchanges);
    } else {
      throw new Error(`[fno] unsupported FNO_MODE: ${mode}`);
    }

    if (!picked) {
      logger.warn(
        { underlying: u, mode, exchanges },
        "[fno] contract not found",
      );
      continue;
    }

    contracts[u] = picked;
    tokens.push(Number(picked.instrument_token));
    symbols.push(`${picked.exchange}:${picked.tradingsymbol}`);
  }

  const uni = {
    ok: true,
    enabled: true,
    universe: {
      ok: true,
      mode,
      underlyings,
      contracts,
      tokens,
      symbols,
      builtAt: new Date().toISOString(),
    },
  };

  lastUniverse = uni;

  if (String(env.FNO_LOG_UNIVERSE || "true").toLowerCase() === "true") {
    logger.info(uni.universe, "[fno] universe built");
  }

  return uni;
}

module.exports = {
  buildFnoUniverse,
  getLastFnoUniverse,
};
