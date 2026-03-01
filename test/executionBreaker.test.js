const { evaluateExecutionBreaker } = require('../src/execution/executionMetrics');

describe('execution breaker', () => {
  test('triggers pause when avg slip exceeds threshold', () => {
    const out = evaluateExecutionBreaker({
      metrics: { recentEntrySlipPts: [2.5, 2.2, 2.1, 2.3, 2.4], orderModifyAttempts: 0 },
      env: {
        EXECUTION_BREAKER_ENABLED: 'true',
        EXEC_BREAKER_AVG_SLIP_PTS_MAX: 2.0,
        EXEC_BREAKER_WINDOW_TRADES: 5,
      },
    });
    expect(out.tripped).toBe(true);
    expect(out.reason).toBe('AVG_SLIPPAGE');
  });
});
