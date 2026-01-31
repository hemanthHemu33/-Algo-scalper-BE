const { DateTime } = require("luxon");
const { env } = require("../config");
const { insertManyCandles, ensureIndexes } = require("./candleStore");

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
      : Number(env.BACKFILL_DAYS || 3),
  );

  const to = DateTime.now().setZone(timezone);
  const from = to.minus({ days });

  const intervalStr = intervalMin === 1 ? "minute" : `${intervalMin}minute`;

  const candles = await kite.getHistoricalData(
    String(instrument_token),
    intervalStr,
    from.toJSDate(),
    to.toJSDate(),
    false,
    false,
  );

  const mapped = (candles || []).map((x) => ({
    instrument_token: Number(instrument_token),
    interval_min: intervalMin,
    ts: new Date(x.date),
    open: Number(x.open),
    high: Number(x.high),
    low: Number(x.low),
    close: Number(x.close),
    volume: Number(x.volume || 0),
    source: "historical",
  }));

  await ensureIndexes(intervalMin);
  await insertManyCandles(intervalMin, mapped);
}

module.exports = { backfillCandles };
