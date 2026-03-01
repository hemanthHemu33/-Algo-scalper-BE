const { applyLiquidityBuffer } = require('../src/trading/liquidityBuffer');

describe('liquidityBuffer', () => {
  test('pushes BUY stop down by ATR buffer and clamps ticks', () => {
    const out = applyLiquidityBuffer({
      env: {
        LIQ_BUFFER_ATR_PCT: 0.1,
        LIQ_BUFFER_MIN_TICKS: 4,
        LIQ_BUFFER_MAX_TICKS: 20,
        AVOID_ROUND_LEVELS: false,
      },
      side: 'BUY',
      candidateSL: 100,
      tickSize: 0.05,
      atrPts: 3,
      ltp: 110,
    });
    expect(out.bufferTicks).toBeGreaterThanOrEqual(6);
    expect(out.bufferedSL).toBeLessThan(100);
  });

  test('applies round number guard in sell direction', () => {
    const out = applyLiquidityBuffer({
      env: {
        LIQ_BUFFER_MIN_TICKS: 4,
        LIQ_BUFFER_MAX_TICKS: 20,
        AVOID_ROUND_LEVELS: true,
        ROUND_LEVEL_STEP: 50,
        ROUND_NUMBER_BUFFER_TICKS: 4,
      },
      side: 'SELL',
      candidateSL: 199.8,
      tickSize: 0.05,
      ltp: 190,
      atrPts: 2,
    });
    expect(out.roundGuardApplied).toBe(true);
    expect(out.bufferedSL).toBeGreaterThanOrEqual(200.2);
  });
});
