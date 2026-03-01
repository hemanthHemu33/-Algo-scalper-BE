const { evaluateExecutionBreaker } = require('../src/execution/executionMetrics');

describe('execution metrics', () => {
  test('breaker stays off when disabled', () => {
    const out = evaluateExecutionBreaker({
      metrics: { recentEntrySlipPts: [10, 10, 10, 10, 10] },
      env: { EXECUTION_BREAKER_ENABLED: 'false' },
    });
    expect(out.tripped).toBe(false);
    expect(out.reason).toBe('DISABLED');
  });
});
