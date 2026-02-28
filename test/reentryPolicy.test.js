const { evaluateReentryOverride } = require("../src/trading/reentryPolicy");

describe("evaluateReentryOverride", () => {
  const baseEnv = {
    REENTRY_AFTER_SL_ENABLED: true,
    REENTRY_AFTER_SL_WINDOW_SEC: 180,
    REENTRY_AFTER_SL_MAX_TRIES: 1,
    REENTRY_AFTER_SL_MIN_CONF: 85,
    REENTRY_AFTER_SL_LATE_MIN_CONF: 80,
    REENTRY_AFTER_SL_R_MULT: 0.5,
    REENTRY_AFTER_SL_ALLOW_DURING_NO_TRADE_WINDOWS: true,
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


  test("allows fresh late-entry override with strict gates and reduced risk", () => {
    const out = evaluateReentryOverride({
      env: {
        ...baseEnv,
        LATE_ENTRY_FRESH_OVERRIDE_ENABLED: true,
        LATE_ENTRY_FRESH_MIN_CONF: 93,
        LATE_ENTRY_FRESH_MAX_SPREAD_BPS: 18,
        LATE_ENTRY_FRESH_MAX_EXPECTED_SLIPPAGE_PTS: 0.8,
        LATE_ENTRY_FRESH_R_MULT: 0.3,
      },
      nowMs: 1_000_000,
      tz: "Asia/Kolkata",
      blockedReason: "after_entry_cutoff",
      signal: { confidence: 95, strategyId: "breakout" },
      riskKey: "NIFTY:breakout",
      stopout: null,
      timeToFlattenSec: 900,
      spreadBps: 12,
      expectedSlippagePts: 0.5,
    });

    expect(out.allow).toBe(true);
    expect(out.riskMult).toBe(0.3);
    expect(out.reason).toBe("fresh_late_entry_allowed");
    expect(out.canTradeCtx).toEqual({
      ignoreCooldown: true,
      allowAfterEntryCutoffUntil: "15:10",
    });
  });

  test("denies fresh late-entry override when spread is too wide", () => {
    const out = evaluateReentryOverride({
      env: {
        ...baseEnv,
        LATE_ENTRY_FRESH_OVERRIDE_ENABLED: true,
        LATE_ENTRY_FRESH_MAX_SPREAD_BPS: 18,
      },
      nowMs: 1_000_000,
      tz: "Asia/Kolkata",
      blockedReason: "after_entry_cutoff",
      signal: { confidence: 95, strategyId: "breakout" },
      riskKey: "NIFTY:breakout",
      stopout: null,
      timeToFlattenSec: 900,
      spreadBps: 24,
      expectedSlippagePts: 0.2,
    });

    expect(out.allow).toBe(false);
    expect(out.reason).toBe("fresh_late_entry_spread_too_wide");
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


  test("allows no-trade-window override when explicitly enabled", () => {
    const out = evaluateReentryOverride({
      env: baseEnv,
      nowMs: 1_000_000,
      tz: "Asia/Kolkata",
      blockedReason: "no_trade_window",
      signal: { confidence: 90, strategyId: "breakout" },
      riskKey: "NIFTY:breakout",
      stopout: { ts: 1_000_000 - 10_000, attempts: 0 },
      timeToFlattenSec: 1200,
    });

    expect(out.allow).toBe(true);
    expect(out.reason).toBe("reentry_allowed");
  });

  test("uses dedicated reentry late min confidence when set", () => {
    const out = evaluateReentryOverride({
      env: { ...baseEnv, LATE_ENTRY_MIN_CONF: 90, REENTRY_AFTER_SL_LATE_MIN_CONF: 80 },
      nowMs: 1_000_000,
      tz: "Asia/Kolkata",
      blockedReason: "after_entry_cutoff",
      signal: { confidence: 86, strategyId: "breakout" },
      riskKey: "NIFTY:breakout",
      stopout: { ts: 1_000_000 - 10_000, attempts: 0 },
      timeToFlattenSec: 900,
    });

    expect(out.allow).toBe(true);
  });

});
