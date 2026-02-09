const { DateTime } = require("luxon");
const { env } = require("../config");
const {
  getSessionForDateTime,
  buildBoundsForToday,
} = require("./marketCalendar");

function isMarketOpenNow(now = new Date()) {
  const tz = env.CANDLE_TZ || "Asia/Kolkata";
  const dt = DateTime.fromJSDate(now, { zone: tz });

  const session = getSessionForDateTime(dt, {
    marketOpen: env.MARKET_OPEN,
    marketClose: env.MARKET_CLOSE,
    stopNewEntriesAfter: env.STOP_NEW_ENTRIES_AFTER,
  });

  if (!session.allowTradingDay) return false;

  const { open, close } = buildBoundsForToday(session, dt);
  if (!open.isValid || !close.isValid) return true;

  return dt >= open && dt <= close;
}

module.exports = { isMarketOpenNow };
