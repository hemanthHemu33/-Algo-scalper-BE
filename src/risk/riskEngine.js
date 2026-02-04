const { env } = require("../config");
const { DateTime } = require("luxon");
const {
  getSessionForDateTime,
  buildBoundsForToday,
} = require("../market/marketCalendar");
const { isHalted } = require("../runtime/halt");

class RiskEngine {
  constructor({ limits, onStateChange } = {}) {
    this.kill = false;
    this.consecutiveFailures = 0;
    this.tradesToday = 0;
    this.openPositions = new Map(); // token -> {tradeId, side, qty}
    this.cooldownUntil = new Map(); // token -> timestamp
    this.limits = limits || {};
    this.onStateChange = typeof onStateChange === "function" ? onStateChange : null;
  }

  setStateChangeHandler(fn) {
    this.onStateChange = typeof fn === "function" ? fn : null;
  }

  setLimits(limits = {}) {
    this.limits = { ...(this.limits || {}), ...(limits || {}) };
  }

  getLimits() {
    return this.limits || {};
  }

  getState() {
    return {
      kill: this.kill,
      consecutiveFailures: this.consecutiveFailures,
      tradesToday: this.tradesToday,
      openPositions: Array.from(this.openPositions.entries()).map(
        ([token, pos]) => ({
          token: Number(token),
          ...pos,
        }),
      ),
      cooldownUntil: Array.from(this.cooldownUntil.entries()).reduce(
        (acc, [token, ts]) => {
          acc[String(token)] = ts;
          return acc;
        },
        {},
      ),
    };
  }

  applyState(state) {
    if (!state) return;
    if (typeof state.kill === "boolean") this.kill = state.kill;
    if (Number.isFinite(Number(state.consecutiveFailures))) {
      this.consecutiveFailures = Number(state.consecutiveFailures);
    }
    if (Number.isFinite(Number(state.tradesToday))) {
      this.tradesToday = Number(state.tradesToday);
    }
    if (Array.isArray(state.openPositions)) {
      this.openPositions = new Map(
        state.openPositions.map((p) => [Number(p.token), { ...p }]),
      );
    }
    if (state.cooldownUntil && typeof state.cooldownUntil === "object") {
      this.cooldownUntil = new Map(
        Object.entries(state.cooldownUntil).map(([token, ts]) => [
          Number(token),
          Number(ts),
        ]),
      );
    }
  }

  _emitStateChange() {
    if (this.onStateChange) this.onStateChange(this.getState());
  }

  setKillSwitch(enabled) {
    this.kill = !!enabled;
    this._emitStateChange();
  }
  getKillSwitch() {
    return this.kill;
  }

  setTradesToday(n) {
    this.tradesToday = Math.max(0, Number(n || 0));
    this._emitStateChange();
  }
  setOpenPosition(token, pos) {
    this.openPositions.set(Number(token), pos);
    this._emitStateChange();
  }
  clearOpenPosition(token) {
    this.openPositions.delete(Number(token));
    this._emitStateChange();
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
    const maxTradesPerDay = Number(
      this.limits?.maxTradesPerDay ?? env.MAX_TRADES_PER_DAY || 8,
    );
    if (Number.isFinite(maxTradesPerDay) && this.tradesToday >= maxTradesPerDay)
      return { ok: false, reason: "max_trades_day" };
    const maxOpenTrades = Number(
      this.limits?.maxOpenTrades ?? env.MAX_OPEN_POSITIONS || 1,
    );
    if (
      Number.isFinite(maxOpenTrades) &&
      this.openPositions.size >= maxOpenTrades
    )
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
    this._emitStateChange();
  }

  markTradeClosed(token) {
    this.openPositions.delete(Number(token));
    const cooldown = Number(env.SYMBOL_COOLDOWN_SECONDS || 180);
    this.cooldownUntil.set(Number(token), Date.now() + cooldown * 1000);
    this._emitStateChange();
  }

  markFailure(reason) {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= Number(env.MAX_CONSECUTIVE_FAILURES || 3)) {
      this.kill = true;
      this._emitStateChange();
      return { killed: true, reason: reason || "failure_limit" };
    }
    this._emitStateChange();
    return { killed: false };
  }

  resetFailures() {
    this.consecutiveFailures = 0;
    this._emitStateChange();
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
