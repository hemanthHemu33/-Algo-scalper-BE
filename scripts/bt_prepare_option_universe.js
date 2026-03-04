#!/usr/bin/env node

const { DateTime } = require("luxon");

const { env } = require("../src/config");
const { connectMongo, getDb } = require("../src/db");
const {
  collectionName,
  ensureIndexes,
  insertManyCandles,
} = require("../src/market/candleStore");
const { createKiteConnect } = require("../src/kite/kiteClients");
const { readLatestTokenDoc } = require("../src/tokenStore");

function getArg(name, fb = null) {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fb;
}

function n(v, d = null) {
  if (v === null || v === undefined || v === "") return d;
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function boolArg(name, fb = false) {
  const v = getArg(name, fb ? "true" : "false");
  return String(v).toLowerCase() === "true";
}

function chainRootFromSpot(tradingsymbol) {
  const m = {
    "NIFTY 50": "NIFTY",
    NIFTY: "NIFTY",
    "NIFTY BANK": "BANKNIFTY",
    BANKNIFTY: "BANKNIFTY",
    "NIFTY FIN SERVICE": "FINNIFTY",
    FINNIFTY: "FINNIFTY",
    "NIFTY MID SELECT": "MIDCPNIFTY",
    MIDCPNIFTY: "MIDCPNIFTY",
  };
  const key = String(tradingsymbol || "")
    .toUpperCase()
    .trim();
  return m[key] || key;
}

function toDate(v) {
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function parseExpiryISO(v) {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) {
    return DateTime.fromJSDate(v, { zone: "utc" }).toISODate();
  }
  if (typeof v === "number") {
    const ms = v < 1e12 ? v * 1000 : v;
    const dt = DateTime.fromMillis(ms, { zone: "utc" });
    return dt.isValid ? dt.toISODate() : null;
  }

  const s = String(v).trim();
  if (!s) return null;

  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];

  const upper = s.toUpperCase().replace(/[\s\-\/]/g, "");
  const m2 = upper.match(
    /^(\d{1,2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{4})$/,
  );
  if (m2) {
    const dd = m2[1].padStart(2, "0");
    const mon = m2[2];
    const yyyy = m2[3];
    const dt = DateTime.fromFormat(`${dd}${mon}${yyyy}`, "ddLLLyyyy", {
      zone: "utc",
    });
    return dt.isValid ? dt.toISODate() : null;
  }

  const d = new Date(s);
  if (Number.isFinite(d.getTime())) {
    return DateTime.fromJSDate(d, { zone: "utc" }).toISODate();
  }

  return null;
}

function roundToStep(price, step) {
  const s = Math.max(1, Number(step ?? 1));
  return Math.round(Number(price) / s) * s;
}

function normalizeInstrumentRow(r) {
  return {
    instrument_token: Number(r.instrument_token),
    strike: Number(r.strike),
    expiry: r.expiry,
    expiryISO: r.expiryISO || parseExpiryISO(r.expiry),
    instrument_type: String(r.instrument_type || "").toUpperCase(),
    tradingsymbol: r.tradingsymbol,
    name: r.name,
    underlying: r.underlying,
  };
}

async function maybeSyncNfoInstruments({
  db,
  kite,
  root,
  optionType,
  windowFromIso,
  windowToIso,
}) {
  const refresh = boolArg("--refreshInstruments", false);
  if (!refresh) {
    return { refreshed: false, instruments: null, validTokenSet: null };
  }

  const instrumentBatch = Math.max(100, n(getArg("--instrumentBatch"), 1000));
  const instrumentMaxTimeMs = Math.max(
    60000,
    n(getArg("--instrumentMaxTimeMs"), 600000),
  );

  const rows = await kite.getInstruments("NFO");
  const wantedTypes =
    optionType === "ALL" ? new Set(["CE", "PE"]) : new Set([optionType]);

  const rootUpper = String(root || "").toUpperCase();
  const byType = rows.filter((r) =>
    wantedTypes.has(String(r.instrument_type || "").toUpperCase()),
  );
  const byRoot = byType.filter((r) => {
    const name = String(r.name || "").toUpperCase();
    const ts = String(r.tradingsymbol || "").toUpperCase();
    const underlying = String(r.underlying || "").toUpperCase();
    return (
      name === rootUpper || underlying === rootUpper || ts.startsWith(rootUpper)
    );
  });

  const byExpiry = byRoot.filter((r) => {
    const iso = parseExpiryISO(r.expiry);
    return iso && iso >= windowFromIso && iso <= windowToIso;
  });

  console.log(`[bt_prepare_options] nfoRows=${rows.length}`);
  console.log(
    `[bt_prepare_options] filterCounts byType=${byType.length} byRoot=${byRoot.length} byExpiry=${byExpiry.length} window=${windowFromIso}..${windowToIso}`,
  );

  if (!byRoot.length) {
    console.warn(
      "No NFO instruments matched root/type filter; skipping instrument cache sync",
    );
    return { refreshed: true, instruments: [], validTokenSet: new Set() };
  }

  const normalized = byRoot.map((r) => normalizeInstrumentRow(r));
  const validTokenSet = new Set(
    normalized.map((r) => r.instrument_token).filter((x) => Number.isFinite(x)),
  );

  // Upsert in batches; normalize expiryISO into cache
  const ops = byRoot.map((r) => {
    const expiryISO = parseExpiryISO(r.expiry);
    return {
      updateOne: {
        filter: { instrument_token: Number(r.instrument_token) },
        update: {
          $set: {
            instrument_token: Number(r.instrument_token),
            exchange: r.exchange,
            tradingsymbol: r.tradingsymbol,
            tick_size: Number(r.tick_size ?? 0.05),
            lot_size: Number(r.lot_size ?? 1),
            segment: r.segment,
            instrument_type: r.instrument_type,
            name: r.name,
            underlying: r.underlying,
            expiry: r.expiry,
            expiryISO,
            strike: Number(r.strike),
            updatedAt: new Date(),
          },
        },
        upsert: true,
      },
    };
  });

  for (let i = 0; i < ops.length; i += instrumentBatch) {
    const chunk = ops.slice(i, i + instrumentBatch);
    await db.collection("instruments_cache").bulkWrite(chunk, {
      ordered: false,
      maxTimeMS: instrumentMaxTimeMs,
    });
    console.log(
      `Synced NFO instrument cache: ${Math.min(i + instrumentBatch, ops.length)}/${ops.length}`,
    );
  }

  const sample = normalized.slice(0, 5).map((r) => ({
    tradingsymbol: r.tradingsymbol,
    expiry: r.expiry,
    expiryISO: r.expiryISO,
  }));
  console.log("[bt_prepare_options] sampleExpiry", sample);

  return { refreshed: true, instruments: normalized, validTokenSet };
}

function pickNearestExpiry(rows, dayIso) {
  const valid = rows
    .map((r) => ({ ...r, expiryISO: r.expiryISO || parseExpiryISO(r.expiry) }))
    .filter((r) => r.expiryISO && r.expiryISO >= dayIso)
    .sort((a, b) => String(a.expiryISO).localeCompare(String(b.expiryISO)));
  if (!valid.length) return null;
  return valid[0].expiryISO;
}

async function fetchDayUnderlyingPrice({ candleCol, token, dayIso, tz }) {
  const start = DateTime.fromISO(dayIso, { zone: tz })
    .startOf("day")
    .toJSDate();
  const end = DateTime.fromISO(dayIso, { zone: tz }).endOf("day").toJSDate();
  const row = await candleCol.findOne(
    { instrument_token: Number(token), ts: { $gte: start, $lte: end } },
    { sort: { ts: -1 }, projection: { close: 1, ts: 1 } },
  );
  return row || null;
}

async function backfillTokenRange({ kite, intervalMin, token, from, to }) {
  const intervalStr = intervalMin === 1 ? "minute" : `${intervalMin}minute`;
  try {
    const rows = await kite.getHistoricalData(
      String(token),
      intervalStr,
      from,
      to,
      false,
      false,
    );
    return (rows || []).map((x) => ({
      instrument_token: Number(token),
      interval_min: intervalMin,
      ts: new Date(x.date),
      open: Number(x.open),
      high: Number(x.high),
      low: Number(x.low),
      close: Number(x.close),
      volume: Number(x.volume ?? 0),
      source: "historical",
    }));
  } catch (e) {
    const msg = String(e?.message || e?.data?.message || e?.errmsg || e || "");
    const et = String(e?.error_type || e?.data?.error_type || "");
    // Kite returns InputException for bad instrument tokens.
    if (
      msg.toLowerCase().includes("invalid token") ||
      et === "InputException"
    ) {
      console.warn(
        `[bt_prepare_options] skip token=${token} (Kite historical rejected instrument token). message=${msg}`,
      );
      return [];
    }
    throw e;
  }
}

async function main() {
  const underlyingToken = n(getArg("--underlyingToken"), NaN);
  const underlyingSymbol = String(getArg("--underlying", "")).trim();
  const optionType = String(getArg("--optionType", "ALL")).toUpperCase();
  const from = toDate(getArg("--from"));
  const to = toDate(getArg("--to"));
  const intervalMin = Math.max(1, n(getArg("--interval"), 1));
  const strikeStep = Math.max(1, n(getArg("--strikeStep"), 50));
  const scanSteps = Math.max(0, n(getArg("--scanSteps"), 2));
  const timezone = String(getArg("--tz", env.TIMEZONE || "Asia/Kolkata"));
  const maxDaysAfterTo = Math.max(
    1,
    n(getArg("--instrumentMaxDaysAfterTo"), 14),
  );

  if (!Number.isFinite(underlyingToken))
    throw new Error("Missing --underlyingToken=<token>");
  if (!from || !to) throw new Error("Missing --from and --to");

  await connectMongo();
  const db = getDb();
  const candleCol = db.collection(collectionName(intervalMin));

  // Underlying candle diagnostics
  const baseQ = { instrument_token: Number(underlyingToken) };
  const totalUnderlying = await candleCol.countDocuments(baseQ);
  const minU = await candleCol
    .find(baseQ)
    .sort({ ts: 1 })
    .limit(1)
    .project({ ts: 1 })
    .toArray();
  const maxU = await candleCol
    .find(baseQ)
    .sort({ ts: -1 })
    .limit(1)
    .project({ ts: 1 })
    .toArray();
  console.log(
    `[bt_prepare_options] underlying token=${underlyingToken} col=${collectionName(intervalMin)} total=${totalUnderlying} minTs=${minU[0]?.ts || null} maxTs=${maxU[0]?.ts || null}`,
  );

  const { accessToken } = await readLatestTokenDoc();
  if (!accessToken)
    throw new Error("No Kite access token found for downloader");
  const kite = createKiteConnect({ apiKey: env.KITE_API_KEY, accessToken });

  const root = chainRootFromSpot(underlyingSymbol);
  const windowFromIso = DateTime.fromJSDate(from, { zone: timezone })
    .startOf("day")
    .toISODate();
  const windowToIso = DateTime.fromJSDate(to, { zone: timezone })
    .plus({ days: maxDaysAfterTo })
    .startOf("day")
    .toISODate();

  const sync = await maybeSyncNfoInstruments({
    db,
    kite,
    root,
    optionType,
    windowFromIso,
    windowToIso,
  });

  // IMPORTANT:
  // If we refreshed instruments, use the freshly fetched list for selection.
  // This prevents stale/expired tokens in instruments_cache from being selected (which causes Kite "invalid token").
  let instruments = null;
  let validTokenSet = null;

  if (sync.refreshed && Array.isArray(sync.instruments)) {
    instruments = sync.instruments;
    validTokenSet = sync.validTokenSet;
  } else {
    const typeQuery = optionType === "ALL" ? { $in: ["CE", "PE"] } : optionType;
    const rootUpper = String(root).toUpperCase();

    const instrumentsRaw = await db
      .collection("instruments_cache")
      .find({
        instrument_type: typeQuery,
        $or: [
          { name: rootUpper },
          { underlying: rootUpper },
          { tradingsymbol: { $regex: `^${rootUpper}` } },
        ],
      })
      .project({
        instrument_token: 1,
        strike: 1,
        expiry: 1,
        expiryISO: 1,
        instrument_type: 1,
        tradingsymbol: 1,
        name: 1,
        underlying: 1,
      })
      .toArray();

    if (!instrumentsRaw.length)
      throw new Error(
        `No instruments_cache options for ${rootUpper} ${optionType}. Try running with --refreshInstruments=true`,
      );
    instruments = instrumentsRaw.map((r) => normalizeInstrumentRow(r));
    validTokenSet = null;
  }

  const missingExpiry = instruments.filter((r) => !r.expiryISO).length;
  if (missingExpiry > 0) {
    console.warn(
      `[bt_prepare_options] warning: ${missingExpiry}/${instruments.length} option instruments missing expiryISO after parsing. Sample:`,
      instruments
        .filter((r) => !r.expiryISO)
        .slice(0, 5)
        .map((r) => ({ ts: r.tradingsymbol, expiry: r.expiry })),
    );
  }

  await ensureIndexes(intervalMin);

  let day = DateTime.fromJSDate(from, { zone: timezone }).startOf("day");
  const endDay = DateTime.fromJSDate(to, { zone: timezone }).startOf("day");

  const selectedTokens = new Set();
  let daysWithSpot = 0;
  let daysNoSpot = 0;
  let daysNoExpiry = 0;

  while (day <= endDay) {
    const dayIso = day.toISODate();
    const spot = await fetchDayUnderlyingPrice({
      candleCol,
      token: underlyingToken,
      dayIso,
      tz: timezone,
    });
    if (!spot) {
      daysNoSpot += 1;
      day = day.plus({ days: 1 });
      continue;
    }
    daysWithSpot += 1;

    const expiry = pickNearestExpiry(instruments, dayIso);
    if (!expiry) {
      daysNoExpiry += 1;
      day = day.plus({ days: 1 });
      continue;
    }

    const atm = roundToStep(Number(spot.close), strikeStep);
    const minStrike = atm - scanSteps * strikeStep;
    const maxStrike = atm + scanSteps * strikeStep;

    const dayTokens = instruments
      .filter((r) => r.expiryISO === expiry)
      .filter(
        (r) => Number(r.strike) >= minStrike && Number(r.strike) <= maxStrike,
      )
      .map((r) => Number(r.instrument_token))
      .filter((tok) => Number.isFinite(tok))
      .filter((tok) => (validTokenSet ? validTokenSet.has(tok) : true));

    dayTokens.forEach((tok) => selectedTokens.add(tok));
    console.log(
      `[${dayIso}] expiry=${expiry} spot=${Number(spot.close).toFixed(2)} atm=${atm} tokens=${dayTokens.length}`,
    );
    day = day.plus({ days: 1 });
  }

  console.log(
    `[bt_prepare_options] daysWithSpot=${daysWithSpot} daysNoSpot=${daysNoSpot} daysNoExpiry=${daysNoExpiry}`,
  );

  const fromDate = new Date(from);
  const toDateObj = new Date(to);
  let totalCandles = 0;

  for (const token of selectedTokens) {
    if (validTokenSet && !validTokenSet.has(token)) {
      console.warn(
        `[bt_prepare_options] skip token=${token} (not present in latest NFO instrument dump; likely stale/expired)`,
      );
      continue;
    }

    const candles = await backfillTokenRange({
      kite,
      intervalMin,
      token,
      from: fromDate,
      to: toDateObj,
    });

    await insertManyCandles(intervalMin, candles);
    totalCandles += candles.length;
    console.log(`backfilled token=${token} candles=${candles.length}`);
  }

  console.log(
    `Done. selectedTokens=${selectedTokens.size} insertedCandles=${totalCandles}`,
  );

  if (sync.refreshed) {
    console.log(
      "[bt_prepare_options] NOTE: Selection used freshly fetched NFO instruments. If you are trying to backtest very old expiries that are no longer present in Kite instruments dump, you must provide your own archived instrument dump and option candle data.",
    );
  }
}

main().catch((err) => {
  console.error("bt_prepare_option_universe failed", err);
  process.exit(1);
});
