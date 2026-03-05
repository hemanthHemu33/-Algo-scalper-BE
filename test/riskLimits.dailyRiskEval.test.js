const { evaluateDailyRiskState } = require('../src/risk/riskLimits');

describe('evaluateDailyRiskState wiring', () => {
  test('exists and never throws on malformed input', () => {
    expect(typeof evaluateDailyRiskState).toBe('function');
    expect(() => evaluateDailyRiskState()).not.toThrow();
    expect(() => evaluateDailyRiskState({ dayPnlR: 'abc', limits: null })).not.toThrow();
    const out = evaluateDailyRiskState({ dayPnlR: -10, limits: { dailyDrawdownPauseR: 3 } });
    expect(out).toEqual(expect.objectContaining({ state: expect.any(String) }));
  });
});
