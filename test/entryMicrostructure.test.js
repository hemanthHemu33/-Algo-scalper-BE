const {
  decidePolicy,
  computeAggressiveIocPrice,
  computeChaseBps,
  shouldUseMarketFallback,
  nextBufferTicks,
} = require('../src/trading/execution/entryMicrostructure');

describe('entryMicrostructure', () => {
  test('IOC BUY price is marketable (>= ask)', () => {
    const px = computeAggressiveIocPrice({ side: 'BUY', bid: 99.9, ask: 100, tickSize: 0.05, bufferTicks: 1 });
    expect(px).toBeGreaterThanOrEqual(100);
  });

  test('IOC SELL price is marketable (<= bid)', () => {
    const px = computeAggressiveIocPrice({ side: 'SELL', bid: 100, ask: 100.2, tickSize: 0.05, bufferTicks: 1 });
    expect(px).toBeLessThanOrEqual(100);
  });

  test('policy selection by spread buckets', () => {
    expect(decidePolicy({ spread_bps: 10, passiveMax: 25, aggressiveMax: 60, hasDepth: true }).policy).toBe('PASSIVE');
    expect(decidePolicy({ spread_bps: 40, passiveMax: 25, aggressiveMax: 60, hasDepth: true }).policy).toBe('AGGRESSIVE');
    expect(decidePolicy({ spread_bps: 90, passiveMax: 25, aggressiveMax: 60, hasDepth: true }).policy).toBe('ABORT');
  });

  test('no depth never chooses IOC', () => {
    const out = decidePolicy({ spread_bps: 40, passiveMax: 25, aggressiveMax: 60, hasDepth: false });
    expect(out.policy).not.toBe('AGGRESSIVE');
    expect(out.reason).toBe('no_depth_for_aggressive');
  });

  test('ladder buffer ticks increments and stops at chase cap', () => {
    const base = 100;
    const capBps = 25;
    let attempt = 1;
    let stopped = false;
    while (attempt <= 10) {
      const buf = nextBufferTicks(1, attempt);
      const chosen = 100 + buf * 0.05;
      const chase = computeChaseBps({ basePrice: base, chosenPrice: chosen, side: 'BUY' });
      if (chase > capBps) {
        stopped = true;
        break;
      }
      attempt += 1;
    }
    expect(stopped).toBe(true);
  });

  test('fallback logic obeys ENTRY_LIMIT_FALLBACK_TO_MARKET', () => {
    expect(shouldUseMarketFallback({ enabled: false, spreadBps: 30, maxSpreadBps: 60 })).toBe(false);
    expect(shouldUseMarketFallback({ enabled: true, spreadBps: 30, maxSpreadBps: 60 })).toBe(true);
    expect(shouldUseMarketFallback({ enabled: true, spreadBps: 70, maxSpreadBps: 60 })).toBe(false);
  });
});
