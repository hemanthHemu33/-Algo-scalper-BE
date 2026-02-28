const { applyLiquidityBuffer } = require('../src/trading/liquidityBuffer');

describe('liquidityBuffer', () => {
  test('pushes BUY stop down by ATR buffer and clamps ticks', () => {
    const out = applyLiquidityBuffer({
      env: {
        LIQUIDITY_BUFFER_MODE: 'ATR',
        LIQUIDITY_BUFFER_ATR_MULT: 0.1,
        LIQUIDITY_BUFFER_MIN_TICKS: 4,
        LIQUIDITY_BUFFER_MAX_TICKS: 20,
        ROUND_NUMBER_GUARD_ENABLED: false,
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
        LIQUIDITY_BUFFER_MODE: 'TICKS',
        LIQUIDITY_BUFFER_MIN_TICKS: 4,
        LIQUIDITY_BUFFER_MAX_TICKS: 20,
        ROUND_NUMBER_GUARD_ENABLED: true,
        ROUND_NUMBER_STEP: 50,
        ROUND_NUMBER_BUFFER_TICKS: 4,
      },
      side: 'SELL',
      candidateSL: 200.1,
      tickSize: 0.05,
      ltp: 190,
    });
    expect(out.roundGuardApplied).toBe(true);
    expect(out.bufferedSL).toBeGreaterThan(200.3);
  });
});
