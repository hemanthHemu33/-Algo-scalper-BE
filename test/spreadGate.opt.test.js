const { validateEntrySpreadDepthPremium } = require('../src/trading/execution/entryMicrostructure');

describe('spread gate opt', () => {
  test('rejects when spread bps too large', () => {
    const out = validateEntrySpreadDepthPremium({
      spreadBps: 75,
      hasDepth: true,
      willUseIoc: true,
      premium: 120,
      minPremium: 30,
      maxSpreadBps: 60,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('spread_too_wide');
  });
});
