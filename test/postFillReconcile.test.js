const { computeEntrySlippagePts, computeEntryMinGreen } = require('../src/trading/tradeManager');

describe('post fill reconcile', () => {
  test('BUY expected 100 fill 101 => +1 slip point', () => {
    expect(computeEntrySlippagePts({ side: 'BUY', expectedEntryPrice: 100, actualFill: 101 })).toBe(1);
  });

  test('BE/min green floor rises with slippage-aware floor', () => {
    const out = computeEntryMinGreen({
      costBasedMinGreenInr: 20,
      riskInr: 100,
      qty: 10,
      entrySlipInr: 30,
      envCfg: {
        MIN_GREEN_ENABLED: 'true',
        MIN_GREEN_COST_MULT: 1,
        MIN_GREEN_MIN_INR: 0,
        MIN_GREEN_R: 0.2,
        MIN_GREEN_SLIP_MULT: 1.5,
      },
    });
    expect(out.slipAwareFloor).toBe(45);
    expect(out.minGreenInr).toBeGreaterThanOrEqual(45);
  });
});
