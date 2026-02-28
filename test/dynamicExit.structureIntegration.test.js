const { computeDynamicExitPlan } = require('../src/trading/dynamicExitManager');

function candles(len = 30, start = 100, step = 0.4) {
  const out = [];
  for (let i = 0; i < len; i += 1) {
    const close = start + i * step;
    out.push({
      timestamp: Date.now() - (len - i) * 60000,
      open: close - 0.2,
      high: close + 0.6,
      low: close - 0.6,
      close,
      volume: 100,
    });
  }
  return out;
}

describe('dynamicExit structure integration', () => {
  test('structure stop tightens desired SL when breakout confirmed', () => {
    const now = Date.now();
    const sessionOpenTs = now - 90 * 60000;
    const structureCandles = candles(40, 100, 0.45);

    const plan = computeDynamicExitPlan({
      trade: {
        side: 'BUY',
        entryPrice: 100,
        initialStopLoss: 90,
        stopLoss: 100,
        qty: 50,
        riskInr: 500,
        minGreenInr: 100,
        minGreenR: 0.2,
        beLocked: true,
        marketContextAtEntry: { regimeTag: 'TREND' },
        instrument: { tick_size: 0.05, segment: 'NSE' },
        quoteAtEntry: { bps: 3 },
      },
      ltp: 120,
      candles: structureCandles,
      nowTs: now,
      env: {
        R_EXIT_POLICY_ENABLED: true,
        MIN_GREEN_ENABLED: 'true',
        BE_ARM_R: 0.6,
        BE_ARM_COST_MULT: 2,
        BE_PROFIT_LOCK_KEEP_R: 0.25,
        DYN_BE_COST_MULT: 1,
        PROFIT_LOCK_ENABLED: 'true',
        PROFIT_LOCK_LADDER: '1.0:0.2',
        PROFIT_LOCK_COST_MULT: 1,
        PROFIT_LOCK_MIN_INR: 0,
        TRAIL_ARM_R: 1.1,
        TRAIL_MODEL: 'ATR',
        TRAIL_ATR_SOURCE: 'PREMIUM',
        TRAIL_ATR_LEN: 14,
        TRAIL_ATR_K_TREND: 1.4,
        TRAIL_ATR_K_RANGE: 1,
        TRAIL_ATR_K_OPEN: 1.6,
        TRAIL_GAP_MIN_PTS: 2,
        TRAIL_GAP_MAX_PTS: 30,
        DYN_TRAIL_STEP_TICKS: 1,
        DYN_STEP_TICKS_PRE_BE: 1,
        DYN_STEP_TICKS_POST_BE: 1,
        TRIGGER_BUFFER_TICKS: 0,
        OPT_EXIT_ALLOW_WIDEN_SL: 'true',
        OPT_EXIT_WIDEN_WINDOW_MIN: 2,
        OPT_EXIT_WIDEN_MAX_RISK_MULT: 1.3,
        TIME_STOP_MIN: 0,
        TIME_STOP_NO_PROGRESS_MIN: 0,
        TIME_STOP_MAX_HOLD_MIN: 0,

        STRUCTURE_ANCHORS_ENABLED: true,
        STRUCTURE_SOURCE: 'TRADE',
        STRUCTURE_CANDLE_LIMIT: 800,
        ORB_ENABLED: true,
        ORB_MINUTES: 15,
        ORB_CONFIRM_MODE: 'CLOSE',
        ORB_CONFIRM_BARS: 1,
        VWAP_ENABLED: true,
        VWAP_CONFIRM_MODE: 'CLOSE',
        VWAP_CONFIRM_BARS: 1,
        DAY_LEVELS_ENABLED: true,
        PREV_DAY_LEVELS_ENABLED: false,
        WEEK_LEVELS_ENABLED: false,
        ANCHOR_BUFFER_TICKS: 2,
        ANCHOR_MIN_GAP_ATR_MULT: 0.3,
        ANCHOR_MIN_GAP_TICKS: 10,
        ANCHOR_MAX_TIGHTEN_PER_EVAL_PTS: 999999,
        ANCHOR_APPLY_AFTER_MIN_GREEN: true,
        ANCHOR_APPLY_AFTER_BE_ARM: true,
        ANCHOR_APPLY_AFTER_PROFIT_LOCK_STEP: false,
        ANCHOR_PRIORITY: 'VWAP,ORB,DAY,PREV_DAY,WEEK',
      },
      quoteSnapshot: { ltp: 120, spreadBps: 1, ts: now },
      structureCandles,
      sessionOpenTs,
    });

    expect(plan.ok).toBe(true);
    expect(plan.meta.structureEnabled).toBe(true);
    expect(plan.meta.structureStop).toBeTruthy();
    expect(plan.meta.desiredStopLoss).toBeGreaterThanOrEqual(plan.meta.structureStop);
    expect(plan.meta.structureChosen).toBeTruthy();
  });
});
