const { DateTime } = require("luxon");
const { env } = require("../config");
const { logger: defaultLogger } = require("../logger");
const { getSessionForDateTime } = require("../market/marketCalendar");

// Keep governor state in its own collection to avoid collisions with legacy risk_state unique indexes.
const PORTFOLIO_GOVERNOR_COLLECTION = "portfolio_governor_state";

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function mkState(date) {
  return {
    date,
    realizedPnlInr: 0,
    realizedPnlR: 0,
    tradesCount: 0,
    lossStreak: 0,
    openRiskInr: 0,
    openTradeRiskInrById: {},
    processedClosedTradeIds: [],
    orderErrorTimestamps: [],
    orderErrorCount: 0,
    orderErrBreakerUntilTs: 0,
    openRiskInrSnapshot: 0,
    lastUpdated: new Date(),
  };
}

class PortfolioGovernor {
  constructor({
    envCfg = env,
    logger = defaultLogger,
    collection,
    legacyCollection,
    nowMs = () => Date.now(),
    sessionResolver,
    baseRInrResolver,
  } = {}) {
    this.env = envCfg;
    this.logger = logger;
    this.collection = collection;
    this.legacyCollection = legacyCollection;
    this.nowMs = nowMs;
    this.sessionResolver =
      sessionResolver ||
      ((now) => {
        const tz = this.env.CANDLE_TZ || "Asia/Kolkata";
        return getSessionForDateTime(DateTime.fromMillis(now, { zone: tz }));
      });
    this.baseRInrResolver = baseRInrResolver || (() => 0);
    this.state = null;
  }

  isEnabled() {
    return String(this.env.PORTFOLIO_GOVERNOR_ENABLED ?? "true") === "true";
  }

  _sessionDate(now = this.nowMs()) {
    const session = this.sessionResolver(now) || {};
    return String(
      session.dayKey ||
        DateTime.fromMillis(now, { zone: this.env.CANDLE_TZ || "Asia/Kolkata" }).toFormat("yyyy-LL-dd"),
    );
  }

  _baseRInr() {
    const fromBudget = toNum(this.baseRInrResolver(), 0);
    if (fromBudget > 0) return fromBudget;
    return Math.max(0, toNum(this.env.BASE_R_INR_FALLBACK ?? 0, 0));
  }

  async init({ openTrades = [] } = {}) {
    await this._ensureCurrentState();
    if (Array.isArray(openTrades) && openTrades.length) {
      await this.recomputeOpenRisk(openTrades);
    }
  }

  async _ensureCurrentState() {
    const date = this._sessionDate();
    if (this.state && this.state.date === date) return this.state;

    const row = this.collection ? await this.collection.findOne({ date }) : null;

    if (row) {
      this.state = {
        ...mkState(date),
        ...row,
        date,
      };
      this._normalizeState();
      this.logger.info(
        { date, source: PORTFOLIO_GOVERNOR_COLLECTION },
        "[portfolio_governor] loaded persisted state",
      );
      return this.state;
    }

    if (this.legacyCollection) {
      const legacy = await this.legacyCollection.findOne({ kind: "portfolio_governor", date });
      if (legacy) {
        this.state = {
          ...mkState(date),
          ...legacy,
          date,
        };
        this._normalizeState();
        this.logger.info(
          { date, source: "risk_state", imported: true },
          "[portfolio_governor] imported legacy state",
        );
        await this._persist();
        return this.state;
      }
    }

    this.state = mkState(date);
    this.logger.info(
      { date, source: "fresh" },
      "[portfolio_governor] initialized new state",
    );
    await this._persist();
    return this.state;
  }

  _normalizeState() {
    const s = this.state || mkState(this._sessionDate());
    s.realizedPnlInr = toNum(s.realizedPnlInr, 0);
    s.realizedPnlR = toNum(s.realizedPnlR, 0);
    s.tradesCount = Math.max(0, Math.floor(toNum(s.tradesCount, 0)));
    s.lossStreak = Math.max(0, Math.floor(toNum(s.lossStreak, 0)));
    s.openRiskInr = Math.max(0, toNum(s.openRiskInr, 0));
    s.openTradeRiskInrById = s.openTradeRiskInrById || {};
    s.processedClosedTradeIds = Array.isArray(s.processedClosedTradeIds)
      ? s.processedClosedTradeIds
      : [];
    s.orderErrorTimestamps = Array.isArray(s.orderErrorTimestamps)
      ? s.orderErrorTimestamps.map((x) => toNum(x, 0)).filter((x) => x > 0)
      : [];
    s.orderErrorCount = Math.max(0, Math.floor(toNum(s.orderErrorCount, 0)));
    s.orderErrBreakerUntilTs = Math.max(0, toNum(s.orderErrBreakerUntilTs, 0));
    s.openRiskInrSnapshot = Math.max(0, toNum(s.openRiskInrSnapshot, s.openRiskInr));
    delete s.createdAt;
    delete s._id;
    delete s.kind;
    this.state = s;
  }

  _trimOrderErrors(now = this.nowMs()) {
    const winMs = Math.max(1, toNum(this.env.ORDER_ERR_BREAKER_WINDOW_SEC, 600)) * 1000;
    this.state.orderErrorTimestamps = this.state.orderErrorTimestamps.filter(
      (ts) => now - toNum(ts, 0) <= winMs,
    );
    this.state.orderErrorCount = this.state.orderErrorTimestamps.length;
  }

  _snapshotMetrics() {
    return {
      realizedPnlInr: toNum(this.state?.realizedPnlInr, 0),
      realizedPnlR: toNum(this.state?.realizedPnlR, 0),
      lossStreak: toNum(this.state?.lossStreak, 0),
      tradesCount: toNum(this.state?.tradesCount, 0),
      openRiskInr: toNum(this.state?.openRiskInr, 0),
      orderErrorCount: toNum(this.state?.orderErrorCount, 0),
      orderErrBreakerUntilTs: toNum(this.state?.orderErrBreakerUntilTs, 0),
    };
  }

  async canOpenNewTrade(ctx = {}) {
    if (!this.isEnabled()) return { ok: true };
    await this._ensureCurrentState();

    const now = this.nowMs();
    this._trimOrderErrors(now);

    const baseRInr = this._baseRInr();
    const realizedPnlR = toNum(this.state.realizedPnlR, 0);
    const openRiskInr = Number.isFinite(Number(ctx.openRiskInr))
      ? Number(ctx.openRiskInr)
      : toNum(this.state.openRiskInr, 0);


    const maxLossR = toNum(this.env.DAILY_MAX_LOSS_R, 0);
    if (maxLossR > 0 && realizedPnlR <= -maxLossR) {
      return this._deny("daily_max_loss_r", { maxLossR, realizedPnlR, baseRInr, openRiskInr });
    }

    const dailyProfitGoalR = toNum(this.env.DAILY_PROFIT_GOAL_R, 0);
    if (dailyProfitGoalR > 0 && realizedPnlR >= dailyProfitGoalR) {
      return this._deny("daily_profit_goal_r", { dailyProfitGoalR, realizedPnlR, baseRInr, openRiskInr });
    }

    const maxLossStreak = Math.max(0, Math.floor(toNum(this.env.MAX_LOSS_STREAK, 0)));
    if (maxLossStreak > 0 && toNum(this.state.lossStreak, 0) >= maxLossStreak) {
      return this._deny("loss_streak", { maxLossStreak, baseRInr, openRiskInr });
    }

    const maxTrades = Math.max(0, Math.floor(toNum(this.env.MAX_TRADES_PER_DAY, 0)));
    if (maxTrades > 0 && toNum(this.state.tradesCount, 0) >= maxTrades) {
      return this._deny("max_trades", { maxTrades, baseRInr, openRiskInr });
    }

    const maxOpenRiskR = toNum(this.env.MAX_OPEN_RISK_R, 0);
    const openRiskR = baseRInr > 0 ? openRiskInr / baseRInr : 0;
    if (maxOpenRiskR > 0 && openRiskR > maxOpenRiskR) {
      return this._deny("max_open_risk", { maxOpenRiskR, openRiskR, baseRInr, openRiskInr });
    }

    if (
      String(this.env.ORDER_ERR_BREAKER_ENABLED ?? "true") === "true" &&
      toNum(this.state.orderErrBreakerUntilTs, 0) > now
    ) {
      return this._deny("order_err_breaker", {
        baseRInr,
        openRiskInr,
        breakerUntilTs: this.state.orderErrBreakerUntilTs,
      });
    }

    await this._persist();
    return { ok: true };
  }

  _deny(reason, extra = {}) {
    const metrics = this._snapshotMetrics();
    this.logger.warn(
      {
        reason,
        ...metrics,
        ...extra,
      },
      "[portfolio_governor] entry denied",
    );
    return {
      ok: false,
      reason,
      metrics,
    };
  }

  async registerTradeOpen(trade = {}) {
    if (!this.isEnabled()) return;
    await this._ensureCurrentState();

    const tradeId = String(trade.tradeId || "").trim();
    const riskInr = Math.max(0, toNum(trade.riskInr, 0));
    if (!tradeId || !(riskInr > 0)) return;

    if (this.state.openTradeRiskInrById[tradeId] > 0) return;
    this.state.openTradeRiskInrById[tradeId] = riskInr;
    this.state.openRiskInr = Object.values(this.state.openTradeRiskInrById).reduce(
      (sum, v) => sum + Math.max(0, toNum(v, 0)),
      0,
    );
    this.state.openRiskInrSnapshot = this.state.openRiskInr;
    await this._persist();
  }

  async registerTradeClose(trade = {}) {
    if (!this.isEnabled()) return;
    await this._ensureCurrentState();

    const tradeId = String(trade.tradeId || "").trim();
    if (tradeId && this.state.processedClosedTradeIds.includes(tradeId)) {
      return;
    }

    const pnlInr = Number(trade.pnlInr);
    const riskInr = toNum(trade.riskInr, 0);
    const includeTradeCount = Number.isFinite(pnlInr);

    if (includeTradeCount) {
      this.state.realizedPnlInr += pnlInr;
      if (riskInr > 0) {
        this.state.realizedPnlR += pnlInr / riskInr;
      }
      this.state.tradesCount += 1;
      this.state.lossStreak = pnlInr < 0 ? this.state.lossStreak + 1 : 0;
    }

    if (tradeId && this.state.openTradeRiskInrById[tradeId] > 0) {
      delete this.state.openTradeRiskInrById[tradeId];
    }
    this.state.openRiskInr = Object.values(this.state.openTradeRiskInrById).reduce(
      (sum, v) => sum + Math.max(0, toNum(v, 0)),
      0,
    );
    this.state.openRiskInrSnapshot = this.state.openRiskInr;

    if (tradeId) {
      this.state.processedClosedTradeIds.push(tradeId);
      if (this.state.processedClosedTradeIds.length > 1000) {
        this.state.processedClosedTradeIds = this.state.processedClosedTradeIds.slice(-500);
      }
    }

    await this._persist();
  }

  async recordOrderError(meta = {}) {
    if (!this.isEnabled()) return;
    if (String(this.env.ORDER_ERR_BREAKER_ENABLED ?? "true") !== "true") return;
    await this._ensureCurrentState();

    const now = this.nowMs();
    this.state.orderErrorTimestamps.push(now);
    this._trimOrderErrors(now);

    const maxErr = Math.max(1, Math.floor(toNum(this.env.ORDER_ERR_BREAKER_MAX, 5)));
    if (this.state.orderErrorCount >= maxErr) {
      const cooldownMs = Math.max(1, toNum(this.env.ORDER_ERR_BREAKER_COOLDOWN_SEC, 900)) * 1000;
      this.state.orderErrBreakerUntilTs = now + cooldownMs;
      this.logger.warn(
        {
          reason: "order_err_breaker",
          orderErrorCount: this.state.orderErrorCount,
          breakerUntilTs: this.state.orderErrBreakerUntilTs,
          meta,
        },
        "[portfolio_governor] order-error breaker armed",
      );
    }

    await this._persist();
  }

  async recomputeOpenRisk(openTrades = []) {
    if (!this.isEnabled()) return;
    await this._ensureCurrentState();

    const next = {};
    for (const trade of openTrades || []) {
      const tradeId = String(trade?.tradeId || "").trim();
      const riskInr = Math.max(0, toNum(trade?.riskInr, 0));
      if (!tradeId || !(riskInr > 0)) continue;
      next[tradeId] = riskInr;
    }

    this.state.openTradeRiskInrById = next;
    this.state.openRiskInr = Object.values(next).reduce((sum, v) => sum + Math.max(0, toNum(v, 0)), 0);
    this.state.openRiskInrSnapshot = this.state.openRiskInr;
    await this._persist();
  }

  async _persist() {
    if (!this.collection || !this.state) return;
    this._normalizeState();
    const safeState = {
      ...this.state,
      lastUpdated: new Date(),
    };
    delete safeState.createdAt;
    delete safeState._id;
    await this.collection.updateOne(
      { date: this.state.date },
      {
        $set: safeState,
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
    this.logger.debug?.(
      {
        date: this.state.date,
        realizedPnlInr: this.state.realizedPnlInr,
        openRiskInr: this.state.openRiskInr,
      },
      "[portfolio_governor] state persisted",
    );
  }
}

async function ensurePortfolioGovernorIndexes(db) {
  await db
    .collection(PORTFOLIO_GOVERNOR_COLLECTION)
    .createIndex({ date: 1 }, { unique: true, name: "uniq_date" });
}

module.exports = {
  PORTFOLIO_GOVERNOR_COLLECTION,
  PortfolioGovernor,
  ensurePortfolioGovernorIndexes,
};
