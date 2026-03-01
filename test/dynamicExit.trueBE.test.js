const { computeDynamicExitPlan } = require('../src/trading/dynamicExitManager');

describe('dynamicExit true breakeven cost math', () => {
  test('applies DYN_BE_COST_MULT exactly once', () => {
    const env = {
      R_EXIT_POLICY_ENABLED: true,
      MIN_GREEN_ENABLED: 'false',
      BE_ARM_R: 0.1,
      BE_ARM_COST_MULT: 1,
      DYN_BE_COST_MULT: 2,
      BE_SLIP_MULT: 1.5,
      BE_SPREAD_MULT: 1,
      TRAIL_ARM_R: 99,
      TRIGGER_BUFFER_TICKS: 0,
      DYN_STEP_TICKS_PRE_BE: 1,
      DYN_STEP_TICKS_POST_BE: 1,
      TIME_STOP_MIN: 0,
      TIME_STOP_NO_PROGRESS_MIN: 0,
      TIME_STOP_MAX_HOLD_MIN: 0,
      STRUCTURE_ANCHORS_ENABLED: false,
    };

    const trade = {
      side: 'BUY',
      strategyId: 'breakout',
      entryPrice: 100,
      initialStopLoss: 95,
      stopLoss: 95,
      qty: 50,
      riskInr: 250,
      entrySlipInr: 50,
      quoteAtEntry: { bps: 20 },
      instrument: { tick_size: 0.05, tradingsymbol: 'ABC', segment: 'NSE' },
    };

    const candles = Array.from({ length: 40 }).map((_, i) => ({
      timestamp: Date.now() - (40 - i) * 60000,
      open: 100 + i * 0.1,
      high: 100 + i * 0.2,
      low: 99 + i * 0.1,
      close: 100 + i * 0.15,
      volume: 100,
    }));

    const plan = computeDynamicExitPlan({
      trade,
      ltp: 102,
      candles,
      nowTs: Date.now(),
      env,
      sessionOpenTs: candles[0].timestamp,
    });

    expect(plan.ok).toBe(true);
    const meta = plan.meta.trueBEMeta;
    expect(meta).toBeTruthy();

    const estCost = Number(meta.estCostInr || 0);
    const expectedOffsetInr = (estCost * 2) + (50 * 1.5) + (meta.spreadCostInr * 1);
    expect(meta.beOffsetInr).toBeCloseTo(expectedOffsetInr, 6);

    const expectedTrueBE = 100 + (expectedOffsetInr / 50);
    expect(plan.meta.trueBE).toBeCloseTo(expectedTrueBE, 2);
  });
});
