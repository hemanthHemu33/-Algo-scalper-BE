const { computeDynamicExitPlan } = require('../src/trading/dynamicExitManager');
const { computeEntryMinGreen } = require('../src/trading/tradeManager');

function buildEnv(overrides = {}) {
  return {
    R_EXIT_POLICY_ENABLED: true,
    MIN_GREEN_ENABLED: 'true',
    MIN_GREEN_R: 0.2,
    MIN_GREEN_COST_MULT: 1.0,
    MIN_GREEN_MIN_INR: 0,
    BE_ARM_R: 0.6,
    BE_ARM_COST_MULT: 2.0,
    BE_PROFIT_LOCK_KEEP_R: 0.25,
    DYN_BE_COST_MULT: 1.0,
    PROFIT_LOCK_ENABLED: 'true',
    PROFIT_LOCK_LADDER: '1.0:0.2,1.5:0.6,2.0:1.0',
    PROFIT_LOCK_MIN_INR: 0,
    PROFIT_LOCK_COST_MULT: 1.0,
    TRAIL_ARM_R: 1.1,
    TRAIL_MODEL: 'ATR',
    TRAIL_ATR_LEN: 14,
    TRAIL_ATR_K_RANGE: 1.0,
    TRAIL_ATR_K_TREND: 1.4,
    TRAIL_ATR_K_OPEN: 1.6,
    TRAIL_GAP_MIN_PTS: 2,
    TRAIL_GAP_MAX_PTS: 10,
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
    ...overrides,
  };
}

function candlesWithAtr(len = 30, atr = 2) {
  const out = [];
  let close = 100;
  for (let i = 0; i < len; i += 1) {
    out.push({
      high: close + atr / 2,
      low: close - atr / 2,
      close,
      ts: Date.now() - (len - i) * 60000,
    });
    close += 0.2;
  }
  return out;
}

describe('R-exit policy', () => {
  test('MIN GREEN derived from R with cost floor', () => {
    const env = buildEnv({ MIN_GREEN_R: 0.2, MIN_GREEN_COST_MULT: 1.0, MIN_GREEN_MIN_INR: 0 });
    const out = computeEntryMinGreen({
      costBasedMinGreenInr: 110,
      riskInr: 1000,
      qty: 50,
      envCfg: env,
    });
    expect(out.minGreenInr).toBeGreaterThanOrEqual(200);
    expect(out.minGreenPts).toBeCloseTo(out.minGreenInr / 50, 6);
  });

  test('BE arm at 0.6R and sets SL to true BE floor', () => {
    const env = buildEnv();
    const trade = {
      side: 'BUY',
      entryPrice: 100,
      initialStopLoss: 90,
      stopLoss: 90,
      qty: 50,
      riskInr: 500,
      minGreenInr: 100,
      instrument: { tick_size: 0.05, segment: 'NSE' },
      quoteAtEntry: { bps: 5 },
    };
    const plan = computeDynamicExitPlan({
      trade,
      ltp: 106.4,
      candles: candlesWithAtr(),
      nowTs: Date.now(),
      env,
      quoteSnapshot: { ltp: 106.4, spreadBps: 2, ts: Date.now() },
    });
    expect(plan.ok).toBe(true);
    expect(plan.meta.trueBE).toBeGreaterThanOrEqual(100);
    if (plan.sl) expect(plan.sl.stopLoss).toBeGreaterThanOrEqual(plan.meta.trueBE);
  });

  test('Profit lock ladder picks highest reached step from mfeR', () => {
    const env = buildEnv();
    const trade = {
      side: 'BUY',
      entryPrice: 100,
      initialStopLoss: 90,
      stopLoss: 100,
      qty: 50,
      riskInr: 500,
      minGreenInr: 100,
      peakPnlInr: 800,
      beLocked: true,
      instrument: { tick_size: 0.05, segment: 'NSE' },
      quoteAtEntry: { bps: 5 },
    };
    const plan = computeDynamicExitPlan({
      trade,
      ltp: 112,
      candles: candlesWithAtr(),
      nowTs: Date.now(),
      env,
      quoteSnapshot: { ltp: 112, spreadBps: 2, ts: Date.now() },
    });
    expect(plan.tradePatch.profitLockStepR).toBeGreaterThanOrEqual(1.0);
    expect(plan.tradePatch.profitLockKeepR).toBeGreaterThan(0);
  });

  test('ATR trailing uses TREND K and activates after TRAIL_ARM_R', () => {
    const env = buildEnv({ TRAIL_ATR_K_TREND: 1.4, DYN_TRAIL_STEP_TICKS: 1 });
    const candles = candlesWithAtr(40, 2);
    const trade = {
      side: 'BUY',
      entryPrice: 100,
      initialStopLoss: 90,
      stopLoss: 101,
      qty: 50,
      riskInr: 500,
      minGreenInr: 100,
      beLocked: true,
      peakLtp: 112,
      marketContextAtEntry: { regimeTag: 'TREND' },
      instrument: { tick_size: 0.05, segment: 'NSE' },
      quoteAtEntry: { bps: 5 },
    };
    const plan = computeDynamicExitPlan({
      trade,
      ltp: 113,
      candles,
      nowTs: Date.now(),
      env,
      quoteSnapshot: { ltp: 113, spreadBps: 2, ts: Date.now() },
    });
    expect(plan.meta.allowTrail).toBe(true);
    expect(plan.meta.trailGapPts).toBeGreaterThan(0);
    expect(plan.meta.K).toBeCloseTo(1.4, 6);
    expect(plan.meta.atrPts).toBeGreaterThan(0);
    expect(plan.tradePatch.trailSl).toBeCloseTo(113 - plan.meta.trailGapPts, 1);
  });

  test('TRAIL_ATR_SOURCE=UNDERLYING maps ATR to premium points via delta', () => {
    const env = buildEnv({
      TRAIL_ATR_SOURCE: 'UNDERLYING',
      TRAIL_ATR_K_RANGE: 1.0,
      TRAIL_GAP_MIN_PTS: 1,
      TRAIL_GAP_MAX_PTS: 50,
    });
    const trade = {
      side: 'BUY',
      entryPrice: 100,
      initialStopLoss: 90,
      stopLoss: 101,
      qty: 50,
      riskInr: 500,
      minGreenInr: 100,
      beLocked: true,
      peakLtp: 112,
      regimeMeta: { atr: 20, regime: 'RANGE' },
      option_meta: { delta: 0.5 },
      marketContextAtEntry: { regimeTag: 'RANGE' },
      instrument: { tick_size: 0.05, segment: 'NFO-OPT' },
      quoteAtEntry: { bps: 5 },
    };
    const plan = computeDynamicExitPlan({
      trade,
      ltp: 113,
      candles: candlesWithAtr(30, 2),
      nowTs: Date.now(),
      env,
      quoteSnapshot: { ltp: 113, spreadBps: 2, ts: Date.now() },
    });
    expect(plan.meta.trailAtrSourceUsed).toBe('UNDERLYING');
    expect(plan.meta.atrPts).toBeCloseTo(10, 6);
    expect(plan.meta.K).toBeCloseTo(1.0, 6);
  });

  test('R thresholds work without RISK_PER_TRADE_INR and BE never loosens stop', () => {
    const env = buildEnv({ RISK_PER_TRADE_INR: undefined, MIN_GREEN_R: 0.25, BE_ARM_R: 0.7, BE_OFFSET_R: 0.1 });
    const trade = {
      side: 'BUY',
      entryPrice: 100,
      initialStopLoss: 90,
      stopLoss: 103,
      qty: 25,
      instrument: { tick_size: 0.05, segment: 'NSE' },
      quoteAtEntry: { bps: 4 },
    };
    const plan = computeDynamicExitPlan({
      trade,
      ltp: 108,
      candles: candlesWithAtr(),
      nowTs: Date.now(),
      env,
      quoteSnapshot: { ltp: 108, spreadBps: 2, ts: Date.now() },
    });
    expect(plan.ok).toBe(true);
    if (plan.sl) expect(plan.sl.stopLoss).toBeGreaterThanOrEqual(103);
  });

});
