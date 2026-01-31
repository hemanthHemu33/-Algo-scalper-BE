const { env } = require("../config");
const { DateTime } = require("luxon");
const {
  getSessionForDateTime,
  buildBoundsForToday,
} = require("../market/marketCalendar");
const { isHalted } = require("../runtime/halt");

class RiskEngine {
  constructor() {
    this.kill = false;
    this.consecutiveFailures = 0;
    this.tradesToday = 0;
    this.openPositions = new Map(); // token -> {tradeId, side, qty}
    this.cooldownUntil = new Map(); // token -> timestamp
  }

  setKillSwitch(enabled) {
    this.kill = !!enabled;
  }
  getKillSwitch() {
    return this.kill;
  }

  setTradesToday(n) {
    this.tradesToday = Math.max(0, Number(n || 0));
  }
  setOpenPosition(token, pos) {
    this.openPositions.set(Number(token), pos);
  }
  clearOpenPosition(token) {
    this.openPositions.delete(Number(token));
  }

  canTrade(token) {
    token = Number(token);

    if (isHalted()) return { ok: false, reason: "halted" };

    // Time window guard (MIS) + Holiday Calendar guard
    const tz = env.CANDLE_TZ || "Asia/Kolkata";
    const now = DateTime.now().setZone(tz);

    // Calendar-aware session (weekends + configured trading holidays + special sessions)
    const session = getSessionForDateTime(now, {
      marketOpen: env.MARKET_OPEN,
      marketClose: env.MARKET_CLOSE,
      stopNewEntriesAfter: env.STOP_NEW_ENTRIES_AFTER,
    });

    if (!session.allowTradingDay) {
      return {
        ok: false,
        reason: session.isWeekend ? "MARKET_CLOSED_WEEKEND" : "MARKET_HOLIDAY",
        meta: {
          dayKey: session.dayKey,
          holidayName: session.holidayName || undefined,
        },
      };
    }

    const {
      open: marketOpen,
      close: marketClose,
      cutoffToday,
    } = buildBoundsForToday(session, now);

    if (marketOpen.isValid && now < marketOpen) {
      return { ok: false, reason: "BEFORE_MARKET_OPEN" };
    }
    if (marketClose.isValid && now > marketClose) {
      return { ok: false, reason: "AFTER_MARKET_CLOSE" };
    }

    // Entry cutoff (use override from special session if provided)
    if (cutoffToday && cutoffToday.isValid && now >= cutoffToday) {
      return { ok: false, reason: "after_entry_cutoff" };
    }

    if (this.consecutiveFailures >= Number(env.MAX_CONSECUTIVE_FAILURES || 3)) {
      return { ok: false, reason: "too_many_failures" };
    }

    if (this.kill) return { ok: false, reason: "kill_switch" };
    if (this.tradesToday >= Number(env.MAX_TRADES_PER_DAY || 8))
      return { ok: false, reason: "max_trades_day" };
    if (this.openPositions.size >= Number(env.MAX_OPEN_POSITIONS || 1))
      return { ok: false, reason: "max_open_positions" };
    if (this.openPositions.has(token))
      return { ok: false, reason: "already_in_position" };
    const until = this.cooldownUntil.get(token) || 0;
    if (Date.now() < until) return { ok: false, reason: "cooldown" };
    return { ok: true };
  }

  markTradeOpened(token, pos) {
    this.tradesToday += 1;
    this.openPositions.set(Number(token), pos);
  }

  markTradeClosed(token) {
    this.openPositions.delete(Number(token));
    const cooldown = Number(env.SYMBOL_COOLDOWN_SECONDS || 180);
    this.cooldownUntil.set(Number(token), Date.now() + cooldown * 1000);
  }

  markFailure(reason) {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= Number(env.MAX_CONSECUTIVE_FAILURES || 3)) {
      this.kill = true;
      return { killed: true, reason: reason || "failure_limit" };
    }
    return { killed: false };
  }

  resetFailures() {
    this.consecutiveFailures = 0;
  }

  calcQty({ entryPrice, stopLoss, riskInr: riskInrOverride }) {
    const riskInr = Number(
      Number.isFinite(Number(riskInrOverride))
        ? riskInrOverride
        : env.RISK_PER_TRADE_INR || 250,
    );
    const perShareRisk = Math.max(0.05, Math.abs(entryPrice - stopLoss));
    return Math.max(1, Math.floor(riskInr / perShareRisk));
  }
}

module.exports = { RiskEngine };
