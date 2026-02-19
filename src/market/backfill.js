const { DateTime } = require("luxon");
const { env } = require("../config");
const { insertManyCandles, ensureIndexes } = require("./candleStore");
const { getMinCandlesForSignal } = require("../strategy/minCandles");

async function backfillCandles({
  kite,
  instrument_token,
  intervalMin,
  timezone,
  daysOverride,
}) {
  const days = Number(
    Number.isFinite(Number(daysOverride))
      ? Number(daysOverride)
      : Number(env.BACKFILL_DAYS ?? 3),
  );
  const maxDays = Number(env.BACKFILL_MAX_DAYS ?? 10);
  const minCandles = getMinCandlesForSignal(env, intervalMin);

  const to = DateTime.now().setZone(timezone);
  const intervalStr = intervalMin === 1 ? "minute" : `${intervalMin}minute`;

  let candles = [];
  let backfillDays = days;
  while (backfillDays <= maxDays) {
    const from = to.minus({ days: backfillDays });
    candles = await kite.getHistoricalData(
      String(instrument_token),
      intervalStr,
      from.toJSDate(),
      to.toJSDate(),
      false,
      false,
    );
    if ((candles || []).length >= minCandles) break;
    backfillDays += 1;
  }

  const mapped = (candles || []).map((x) => ({
    instrument_token: Number(instrument_token),
    interval_min: intervalMin,
    ts: new Date(x.date),
    open: Number(x.open),
    high: Number(x.high),
    low: Number(x.low),
    close: Number(x.close),
    volume: Number(x.volume ?? 0),
    source: "historical",
  }));

  await ensureIndexes(intervalMin);
  await insertManyCandles(intervalMin, mapped);

  return mapped;
}

module.exports = { backfillCandles };
