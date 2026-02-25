const { env } = require("../config");
const { logger } = require("../logger");
const { equityService } = require("../account/equityService");
const { riskMultiplierForState } = require("./riskLimits");

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

function equityFromSnapshot(snapshot, source) {
  const src = String(source || "AVAILABLE_MARGIN").trim().toUpperCase();
  const available = Number(snapshot?.available);
  const equity = Number(snapshot?.equity);
  const cash = Number(snapshot?.cash);

  if (src === "EQUITY") return Number.isFinite(equity) ? equity : NaN;
  if (src === "CASH") return Number.isFinite(cash) ? cash : NaN;
  if (src === "MAX_AVAILABLE_EQUITY") {
    return Math.max(
      Number.isFinite(available) ? available : 0,
      Number.isFinite(equity) ? equity : 0,
    );
  }
  if (src === "MIN_AVAILABLE_EQUITY") {
    const vals = [available, equity].filter((v) => Number.isFinite(v));
    return vals.length ? Math.min(...vals) : NaN;
  }
  if (src === "FIXED") return Number(env.RISK_EQUITY_FIXED_INR ?? NaN);

  return Number.isFinite(available)
    ? available
    : Number.isFinite(equity)
      ? equity
      : NaN;
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
        source: this.snapshot.source || null,
      },
      "[riskBudget] initialized",
    );
  }

  async refresh({ signalCtx } = {}) {
    if (!env.RISK_BUDGET_ENABLED) return this.snapshot;

    const marginUsePct = clamp(env.MARGIN_USE_PCT ?? 0.9, 0, 1);
    let usableEquityBase = 0;
    let sourceResolved = String(env.RISK_EQUITY_SOURCE || "AVAILABLE_MARGIN");
    try {
      const snap = await equityService.snapshot({ kite: this.kite });
      const point = snap?.snapshot || null;
      const picked = equityFromSnapshot(point, sourceResolved);
      if (Number.isFinite(picked) && picked > 0) {
        usableEquityBase = picked;
      } else {
        sourceResolved = "AVAILABLE_MARGIN_FALLBACK";
        usableEquityBase = Number(point?.available ?? point?.equity ?? 0);
      }
    } catch {
      usableEquityBase = 0;
      sourceResolved = `${sourceResolved}_ERROR_FALLBACK`;
    }

    const eqFloor = Math.max(0, Number(env.RISK_EQUITY_FLOOR_INR ?? 0));
    const equityUsedInr = Math.max(eqFloor, usableEquityBase * marginUsePct);

    const volTargetBps = Math.max(1, Number(env.RISK_VOL_TARGET_BPS ?? 65));
    const atrBps = Number(signalCtx?.atrBps);
    const atrPct = Number(signalCtx?.atrPct);
    const signalVolBps = Number.isFinite(atrBps)
      ? atrBps
      : Number.isFinite(atrPct)
        ? atrPct * 100
        : NaN;
    const volRaw = Number.isFinite(signalVolBps) && signalVolBps > 0 ? volTargetBps / signalVolBps : 1;
    const volScaler = clamp(
      volRaw,
      Number(env.RISK_VOL_SCALER_MIN ?? 0.65),
      Number(env.RISK_VOL_SCALER_MAX ?? 1.4),
    );

    const baseRiskPct = clamp(env.RISK_BASE_PCT_PER_TRADE ?? 0.0035, 0.0001, 0.05);
    const sessionRInr = Math.max(0, equityUsedInr * baseRiskPct * volScaler);

    this.snapshot = {
      equityUsedInr,
      volScaler,
      sessionRInr,
      source: sourceResolved,
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
    this.dayState = ["RUNNING", "THROTTLED", "PAUSED", "PROFIT_LOCK"].includes(s)
      ? s
      : "RUNNING";
  }

  _dayRiskMult() {
    return riskMultiplierForState(this.getDayState());
  }

  async getTradeRiskInr(signalCtx = {}) {
    if (!env.RISK_BUDGET_ENABLED) return Number(env.RISK_PER_TRADE_INR ?? 0);
    await this.refresh({ signalCtx });
    const base = this.getSessionRInr();
    const q = confidenceScaler(signalCtx.confidence) * regimeScaler(signalCtx.regime) * spreadScaler(signalCtx.spreadBps);
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
