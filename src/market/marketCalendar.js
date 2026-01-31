const fs = require("fs");
const path = require("path");
const { DateTime } = require("luxon");
const { env } = require("../config");

// -----------------------------------------------------------------------------
// Market Calendar (Holidays + Special Sessions)
// - Purpose: prevent trading / candle build on NSE holidays, not just weekends
// - Update: edit config/market_calendar.json yearly (manual is fine)
// - Special sessions: allowTrading + open/close overrides (e.g., Muhurat / early close)
// -----------------------------------------------------------------------------

let _cache = null;

function _truthy(v) {
  return String(v || "false").toLowerCase() === "true";
}

function _resolvePath(p) {
  if (!p) return null;
  if (path.isAbsolute(p)) return p;
  return path.join(process.cwd(), p);
}

function _defaultCalendarFallback() {
  // Safe fallback: no extra holidays beyond weekends.
  return {
    name: "fallback-empty-calendar",
    tz: env.CANDLE_TZ || "Asia/Kolkata",
    holidays: [],
    weekend_holidays: [],
    special_sessions: [],
  };
}

function _normalizeCalendar(raw) {
  const cal = raw && typeof raw === "object" ? raw : {};
  const tz = cal.tz || env.CANDLE_TZ || "Asia/Kolkata";

  const holidays = Array.isArray(cal.holidays) ? cal.holidays : [];
  const weekendH = Array.isArray(cal.weekend_holidays) ? cal.weekend_holidays : [];
  const sessions = Array.isArray(cal.special_sessions) ? cal.special_sessions : [];

  const toObjList = (arr) =>
    arr
      .map((x) => {
        if (!x) return null;
        if (typeof x === "string") return { date: x, name: "Holiday" };
        if (typeof x === "object" && x.date) return x;
        return null;
      })
      .filter(Boolean)
      .map((x) => ({
        date: String(x.date).slice(0, 10),
        name: String(x.name || "Holiday"),
      }));

  const toSessionList = (arr) =>
    arr
      .map((x) => {
        if (!x || typeof x !== "object" || !x.date) return null;
        return {
          date: String(x.date).slice(0, 10),
          name: String(x.name || "Special Session"),
          allowTrading: _truthy(x.allowTrading),
          open: x.open ? String(x.open) : null, // HH:mm
          close: x.close ? String(x.close) : null, // HH:mm
          stopNewEntriesAfter: x.stopNewEntriesAfter ? String(x.stopNewEntriesAfter) : null, // HH:mm
        };
      })
      .filter(Boolean);

  return {
    name: String(cal.name || "market_calendar"),
    tz,
    holidays: toObjList(holidays),
    weekend_holidays: toObjList(weekendH),
    special_sessions: toSessionList(sessions),
    source_note: String(cal.source_note || ""),
  };
}

function loadMarketCalendar({ force = false } = {}) {
  if (_cache && !force) return _cache;

  const enabled = _truthy(env.HOLIDAY_CALENDAR_ENABLED);
  if (!enabled) {
    _cache = _defaultCalendarFallback();
    return _cache;
  }

  const fileRel = env.HOLIDAY_CALENDAR_FILE || "config/market_calendar.json";
  const filePath = _resolvePath(fileRel);

  let raw = null;
  try {
    if (filePath && fs.existsSync(filePath)) {
      const txt = fs.readFileSync(filePath, "utf8");
      raw = JSON.parse(txt);
    }
  } catch (e) {
    // fallthrough to default fallback
    raw = null;
  }

  _cache = _normalizeCalendar(raw || _defaultCalendarFallback());

  if (_truthy(env.HOLIDAY_CALENDAR_LOG)) {
    const holCount = _cache.holidays.length;
    const sesCount = _cache.special_sessions.length;
    // eslint-disable-next-line no-console
    console.log(
      `[calendar] loaded name=${_cache.name} tz=${_cache.tz} holidays=${holCount} specialSessions=${sesCount} file=${filePath || "n/a"}`,
    );
  }

  return _cache;
}

function reloadMarketCalendar() {
  return loadMarketCalendar({ force: true });
}

function getMarketCalendarMeta() {
  const c = loadMarketCalendar();
  const fileRel = env.HOLIDAY_CALENDAR_FILE || "config/market_calendar.json";
  const filePath = _resolvePath(fileRel);
  return {
    ok: true,
    enabled: _truthy(env.HOLIDAY_CALENDAR_ENABLED),
    name: c.name,
    tz: c.tz,
    file: fileRel,
    fileResolved: filePath,
    holidays: c.holidays.length,
    specialSessions: c.special_sessions.length,
    source_note: c.source_note,
  };
}

function _dayKeyFromDt(dt) {
  return dt.toFormat("yyyy-LL-dd");
}

function _findHoliday(dayKey) {
  const c = loadMarketCalendar();
  return c.holidays.find((h) => h.date === dayKey) || null;
}

function _findSpecialSession(dayKey) {
  const c = loadMarketCalendar();
  if (!_truthy(env.SPECIAL_SESSIONS_ENABLED)) return null;
  return c.special_sessions.find((s) => s.date === dayKey) || null;
}

function getSessionForDateTime(dt, { marketOpen, marketClose, stopNewEntriesAfter } = {}) {
  const c = loadMarketCalendar();
  const tz = c.tz || env.CANDLE_TZ || "Asia/Kolkata";
  const now = dt.setZone(tz);

  const dayKey = _dayKeyFromDt(now);

  const special = _findSpecialSession(dayKey);
  const isWeekend = now.weekday === 6 || now.weekday === 7;
  const holiday = _findHoliday(dayKey);

  // Base session times
  const baseOpen = String(marketOpen || env.MARKET_OPEN || "09:15");
  const baseClose = String(marketClose || env.MARKET_CLOSE || "15:30");
  const baseCutoff = String(stopNewEntriesAfter || env.STOP_NEW_ENTRIES_AFTER || "15:00");

  // If special session exists, it can override open/close/cutoff and allow trading even on weekend/holiday.
  const openStr = special?.open || baseOpen;
  const closeStr = special?.close || baseClose;
  const cutoffStr = special?.stopNewEntriesAfter || baseCutoff;

  const allowTradingDay = !!(special?.allowTrading) || (!isWeekend && !holiday);

  return {
    tz,
    dayKey,
    isWeekend,
    isHoliday: !!holiday,
    holidayName: holiday?.name || null,
    specialSession: special
      ? {
          date: special.date,
          name: special.name,
          allowTrading: !!special.allowTrading,
          open: special.open,
          close: special.close,
          stopNewEntriesAfter: special.stopNewEntriesAfter,
        }
      : null,
    allowTradingDay,
    openStr,
    closeStr,
    cutoffStr,
  };
}

function buildBoundsForToday(session, dt) {
  const tz = session.tz;
  const now = dt.setZone(tz);

  const open = DateTime.fromFormat(session.openStr, "HH:mm", { zone: tz }).set({
    year: now.year,
    month: now.month,
    day: now.day,
    second: 0,
    millisecond: 0,
  });

  const close = DateTime.fromFormat(session.closeStr, "HH:mm", { zone: tz }).set({
    year: now.year,
    month: now.month,
    day: now.day,
    second: 0,
    millisecond: 0,
  });

  const cutoff = DateTime.fromFormat(session.cutoffStr, "HH:mm", { zone: tz });
  const cutoffToday = cutoff.isValid
    ? now.set({
        hour: cutoff.hour,
        minute: cutoff.minute,
        second: 0,
        millisecond: 0,
      })
    : null;

  return { open, close, cutoffToday };
}

function getMarketStatusNow() {
  const tz = env.CANDLE_TZ || "Asia/Kolkata";
  const now = DateTime.now().setZone(tz);
  const session = getSessionForDateTime(now);

  const { open, close, cutoffToday } = buildBoundsForToday(session, now);

  const out = {
    ok: true,
    now: now.toISO(),
    dayKey: session.dayKey,
    tz: session.tz,
    allowTradingDay: session.allowTradingDay,
    isWeekend: session.isWeekend,
    isHoliday: session.isHoliday,
    holidayName: session.holidayName,
    specialSession: session.specialSession,
    open: session.openStr,
    close: session.closeStr,
    entryCutoff: session.cutoffStr,
    openIso: open.isValid ? open.toISO() : null,
    closeIso: close.isValid ? close.toISO() : null,
    entryCutoffIso: cutoffToday?.isValid ? cutoffToday.toISO() : null,
  };

  if (!session.allowTradingDay) {
    out.isOpen = false;
    out.reason = session.isWeekend ? "MARKET_CLOSED_WEEKEND" : "MARKET_HOLIDAY";
    return out;
  }

  if (open.isValid && now < open) {
    out.isOpen = false;
    out.reason = "BEFORE_MARKET_OPEN";
    return out;
  }
  if (close.isValid && now > close) {
    out.isOpen = false;
    out.reason = "AFTER_MARKET_CLOSE";
    return out;
  }
  out.isOpen = true;
  out.reason = "IN_SESSION";
  return out;
}

module.exports = {
  loadMarketCalendar,
  reloadMarketCalendar,
  getMarketCalendarMeta,
  getSessionForDateTime,
  buildBoundsForToday,
  getMarketStatusNow,
};
