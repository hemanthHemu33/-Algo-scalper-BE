const { evaluateReentryOverride } = require("../src/trading/reentryPolicy");

describe("evaluateReentryOverride", () => {
  const baseEnv = {
    REENTRY_AFTER_SL_ENABLED: true,
    REENTRY_AFTER_SL_WINDOW_SEC: 180,
    REENTRY_AFTER_SL_MAX_TRIES: 1,
    REENTRY_AFTER_SL_MIN_CONF: 85,
    REENTRY_AFTER_SL_R_MULT: 0.5,
    REENTRY_AFTER_SL_ALLOWED_STRATEGIES:
      "breakout,vwap_reclaim,volume_spike,bollinger_squeeze,ema_pullback",
    LATE_ENTRY_OVERRIDE_ENABLED: true,
    LATE_ENTRY_ALLOW_UNTIL: "15:10",
    LATE_ENTRY_MIN_CONF: 85,
    LATE_ENTRY_MIN_TIME_TO_FLATTEN_SEC: 600,
  };

  test("allows cooldown re-entry when all conditions pass", () => {
    const out = evaluateReentryOverride({
      env: baseEnv,
      nowMs: 1_000_000,
      tz: "Asia/Kolkata",
      blockedReason: "cooldown",
      signal: { confidence: 90, strategyId: "breakout" },
      riskKey: "NIFTY:breakout",
      stopout: { ts: 1_000_000 - 30_000, attempts: 0 },
      timeToFlattenSec: 1200,
    });

    expect(out.allow).toBe(true);
    expect(out.riskMult).toBe(0.5);
    expect(out.canTradeCtx).toEqual({ ignoreCooldown: true });
  });

  test("denies when max attempts reached", () => {
    const out = evaluateReentryOverride({
      env: baseEnv,
      nowMs: 1_000_000,
      tz: "Asia/Kolkata",
      blockedReason: "cooldown",
      signal: { confidence: 90, strategyId: "breakout" },
      riskKey: "NIFTY:breakout",
      stopout: { ts: 1_000_000 - 10_000, attempts: 1 },
      timeToFlattenSec: 1200,
    });

    expect(out.allow).toBe(false);
  });

  test("denies when confidence is below threshold", () => {
    const out = evaluateReentryOverride({
      env: baseEnv,
      nowMs: 1_000_000,
      tz: "Asia/Kolkata",
      blockedReason: "cooldown",
      signal: { confidence: 70, strategyId: "breakout" },
      riskKey: "NIFTY:breakout",
      stopout: { ts: 1_000_000 - 10_000, attempts: 0 },
      timeToFlattenSec: 1200,
    });

    expect(out.allow).toBe(false);
  });

  test("after cutoff requires late-entry constraints", () => {
    const allowOut = evaluateReentryOverride({
      env: baseEnv,
      nowMs: 1_000_000,
      tz: "Asia/Kolkata",
      blockedReason: "after_entry_cutoff",
      signal: { confidence: 90, strategyId: "breakout" },
      riskKey: "NIFTY:breakout",
      stopout: { ts: 1_000_000 - 10_000, attempts: 0 },
      timeToFlattenSec: 900,
    });

    expect(allowOut.allow).toBe(true);
    expect(allowOut.canTradeCtx).toEqual({
      ignoreCooldown: true,
      allowAfterEntryCutoffUntil: "15:10",
    });

    const denyOut = evaluateReentryOverride({
      env: baseEnv,
      nowMs: 1_000_000,
      tz: "Asia/Kolkata",
      blockedReason: "after_entry_cutoff",
      signal: { confidence: 90, strategyId: "breakout" },
      riskKey: "NIFTY:breakout",
      stopout: { ts: 1_000_000 - 10_000, attempts: 0 },
      timeToFlattenSec: 500,
    });
    expect(denyOut.allow).toBe(false);
  });
});
