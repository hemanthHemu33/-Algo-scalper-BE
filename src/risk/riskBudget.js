const { env } = require("../config");
const { logger } = require("../logger");
const { equityService } = require("../account/equityService");

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function confidenceScaler(confidence) {
  if (!env.RISK_SCALE_BY_CONFIDENCE) return 1;
  const c = Number(confidence);
  if (!Number.isFinite(c)) return 1;
  if (c >= 85) return 1.15;
  if (c >= 75) return 1.05;
  if (c >= 65) return 1;
  if (c >= 55) return 0.85;
  return 0.75;
}

function regimeScaler(regime) {
  if (!env.RISK_SCALE_BY_REGIME) return 1;
  const r = String(regime || "").toUpperCase();
  if (r.includes("TREND")) return 1.05;
  if (r.includes("OPEN")) return 0.95;
  if (r.includes("RANGE")) return 0.9;
  return 1;
}

function spreadScaler(spreadBps) {
  if (!env.RISK_SCALE_BY_SPREAD) return 1;
  const bps = Number(spreadBps);
  if (!Number.isFinite(bps)) return 1;
  if (bps <= 12) return 1.05;
  if (bps <= 20) return 1;
  if (bps <= 30) return 0.9;
  return 0.75;
}

class RiskBudget {
  constructor({ kite } = {}) {
    this.kite = kite;
    this.dayState = "RUNNING";
    this.snapshot = {
      equityUsedInr: 0,
      volScaler: 1,
      sessionRInr: Number(env.RISK_PER_TRADE_INR ?? 0),
      updatedAt: null,
    };
    this._logStartupSnapshot().catch(() => {});
  }

  async _logStartupSnapshot() {
    await this.refresh();
    logger.info(
      {
        equityUsedInr: this.snapshot.equityUsedInr,
        volScaler: this.snapshot.volScaler,
        sessionRInr: this.snapshot.sessionRInr,
      },
      "[riskBudget] initialized",
    );
  }

  async refresh({ signalCtx } = {}) {
    if (!env.RISK_BUDGET_ENABLED) return this.snapshot;

    const marginUsePct = clamp(Number(env.MARGIN_USE_PCT ?? 100) / 100, 0, 1);
    let available = 0;
    try {
      const snap = await equityService.snapshot({ kite: this.kite });
      available = Number(
        snap?.snapshot?.available ?? snap?.snapshot?.equity ?? 0,
      );
    } catch {
      available = 0;
    }

    const eqFloor = Math.max(0, Number(env.RISK_EQUITY_FLOOR_INR ?? 0));
    const equityUsedInr = Math.max(eqFloor, available * marginUsePct);

    const volTargetBps = Math.max(1, Number(env.RISK_VOL_TARGET_BPS ?? 65));
    const atrBps = Number(signalCtx?.atrBps);
    const atrPct = Number(signalCtx?.atrPct);
    const signalVolBps = Number.isFinite(atrBps)
      ? atrBps
      : Number.isFinite(atrPct)
        ? atrPct * 100
        : NaN;
    const volRaw =
      Number.isFinite(signalVolBps) && signalVolBps > 0
        ? volTargetBps / signalVolBps
        : 1;
    const volScaler = clamp(
      volRaw,
      Number(env.RISK_VOL_SCALER_MIN ?? 0.65),
      Number(env.RISK_VOL_SCALER_MAX ?? 1.4),
    );

    const baseRiskPct = clamp(
      env.RISK_BASE_PCT_PER_TRADE ?? 0.0035,
      0.0001,
      0.05,
    );
    const sessionRInr = Math.max(0, equityUsedInr * baseRiskPct * volScaler);

    this.snapshot = {
      equityUsedInr,
      volScaler,
      sessionRInr,
      updatedAt: Date.now(),
    };

    return this.snapshot;
  }

  getSessionRInr() {
    if (!env.RISK_BUDGET_ENABLED) return Number(env.RISK_PER_TRADE_INR ?? 0);
    return Number(this.snapshot?.sessionRInr ?? 0);
  }

  getDayState() {
    return this.dayState || "RUNNING";
  }

  setDayState(state) {
    const s = String(state || "RUNNING").toUpperCase();
    this.dayState = ["RUNNING", "THROTTLED", "PAUSED", "PROFIT_LOCK"].includes(
      s,
    )
      ? s
      : "RUNNING";
  }

  _dayRiskMult() {
    const st = this.getDayState();
    if (st === "THROTTLED")
      return Number(env.DAILY_DD_THROTTLE_RISK_MULT ?? 0.6);
    if (st === "PROFIT_LOCK")
      return Number(env.DAILY_PROFIT_LOCK_RISK_MULT ?? 0.5);
    if (st === "PAUSED") return 0;
    return 1;
  }

  async getTradeRiskInr(signalCtx = {}) {
    if (!env.RISK_BUDGET_ENABLED) return Number(env.RISK_PER_TRADE_INR ?? 0);
    await this.refresh({ signalCtx });
    const base = this.getSessionRInr();
    const q =
      confidenceScaler(signalCtx.confidence) *
      regimeScaler(signalCtx.regime) *
      spreadScaler(signalCtx.spreadBps);
    const baseMult = Number(env.RISK_TRADE_R_BASE ?? 1.0);
    const qClamped = clamp(
      q * (Number.isFinite(baseMult) ? baseMult : 1),
      Number(env.RISK_TRADE_R_MIN ?? 0.6),
      Number(env.RISK_TRADE_R_MAX ?? 1.25),
    );
    const dayMult = this._dayRiskMult();
    return Math.max(0, base * qClamped * dayMult);
  }
}

module.exports = { RiskBudget };
