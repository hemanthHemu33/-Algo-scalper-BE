const { computeDynamicExitPlan } = require('../src/trading/dynamicExitManager');

function candles(len = 40, start = 95, step = 0.8) {
  const out = [];
  const baseTs = Date.now() - len * 60000;
  for (let i = 0; i < len; i += 1) {
    const close = start + i * step;
    out.push({
      timestamp: baseTs + i * 60000,
      open: close - 0.4,
      high: close + 0.8,
      low: close - 0.8,
      close,
      volume: 100 + i,
    });
  }
  return out;
}

describe('dynamicExit structure integration', () => {
  const baseEnv = {
    R_EXIT_POLICY_ENABLED: true,
    MIN_GREEN_ENABLED: 'true',
    MIN_GREEN_R: 0.2,
    BE_ARM_R: 0.6,
    BE_ARM_COST_MULT: 2,
    BE_PROFIT_LOCK_KEEP_R: 0.25,
    DYN_BE_COST_MULT: 1,
    PROFIT_LOCK_ENABLED: 'true',
    PROFIT_LOCK_LADDER: '1.0:0.20',
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
    TIME_STOP_MIN: 0,
    TIME_STOP_NO_PROGRESS_MIN: 0,
    TIME_STOP_MAX_HOLD_MIN: 0,

    STRUCTURE_ANCHORS_ENABLED: true,
    LEVELS_CACHE_TTL_SEC: 30,
    VWAP_ENABLED: true,
    ORB_MINUTES: 15,
    SWING_LOOKBACK: 20,
    STRATEGY_STOP_ANCHOR_MAP: 'breakout:ORB,ema_pullback:SWING,vwap_reclaim:VWAP,fakeout:DAY_LEVEL',
    LIQ_BUFFER_ATR_PCT: 0.1,
    LIQ_BUFFER_MIN_TICKS: 4,
    LIQ_BUFFER_MAX_TICKS: 30,
    AVOID_ROUND_LEVELS: true,
    ROUND_LEVEL_STEP: 50,

    VOL_SCALER_ENABLED: true,
    VOL_ATR_TARGET_PTS: 18,
    VOL_SCALER_MIN: 0.8,
    VOL_SCALER_MAX: 1.3,
  };

  test('structure floor raises SL above BE floor when min-green gate is passed', () => {
    const now = Date.now();
    const structureCandles = candles();
    const plan = computeDynamicExitPlan({
      trade: {
        side: 'BUY',
        strategyId: 'vwap_reclaim',
        entryPrice: 100,
        initialStopLoss: 95,
        stopLoss: 100,
        qty: 50,
        riskInr: 500,
        minGreenInr: 20,
        minGreenR: 0.2,
        beLocked: true,
        instrument: { tick_size: 0.05, segment: 'NSE', tradingsymbol: 'TEST1' },
      },
      ltp: 120,
      candles: structureCandles,
      nowTs: now,
      env: baseEnv,
      structureCandles,
      sessionOpenTs: structureCandles[0].timestamp,
    });

    expect(plan.ok).toBe(true);
    expect(plan.meta.structureEnabled).toBe(true);
    expect(plan.meta.structureStop).toBeTruthy();
    expect(plan.meta.structureStop).toBeGreaterThanOrEqual(plan.meta.beFloor);
  });

  test('round-level avoidance shifts SL away from obvious level', () => {
    const now = Date.now();
    const structureCandles = Array.from({ length: 30 }).map((_, i) => ({
      timestamp: now - (30 - i) * 60000,
      open: 200,
      high: 200,
      low: 200,
      close: 200,
      volume: 100,
    }));
    const plan = computeDynamicExitPlan({
      trade: {
        side: 'BUY',
        strategyId: 'vwap_reclaim',
        entryPrice: 190,
        initialStopLoss: 180,
        stopLoss: 195,
        qty: 50,
        riskInr: 500,
        minGreenInr: 20,
        minGreenR: 0.2,
        beLocked: true,
        instrument: { tick_size: 0.05, segment: 'NSE', tradingsymbol: 'TEST2' },
      },
      ltp: 220,
      candles: structureCandles,
      nowTs: now,
      env: {
        ...baseEnv,
        LIQ_BUFFER_ATR_PCT: 0,
        LIQ_BUFFER_MIN_TICKS: 0,
        LIQ_BUFFER_MAX_TICKS: 0,
        ROUND_LEVEL_STEP: 50,
        ROUND_NUMBER_BUFFER_TICKS: 6,
      },
      structureCandles,
      sessionOpenTs: structureCandles[0].timestamp,
    });

    expect(plan.ok).toBe(true);
    expect(plan.meta.structureRoundGuardApplied).toBe(true);
    expect(plan.meta.structureFloorAfterBuffer).not.toBe(plan.meta.structureFloorBeforeBuffer);
  });
});
