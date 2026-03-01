const { computeStopAnchor } = require('../src/trading/stopAnchors');

describe('stopAnchors', () => {
  test('uses strategy mapping and applies atr liquidity buffer', () => {
    const out = computeStopAnchor({
      strategyId: 'breakout',
      side: 'BUY',
      levels: { orbLow: 100, dayLow: 99, vwap: 102, lastSwingLow: 98 },
      nowContext: {
        env: {
          STRATEGY_STOP_ANCHOR_MAP: 'breakout:ORB,ema_pullback:SWING',
          LIQ_BUFFER_ATR_PCT: 0.1,
          LIQ_BUFFER_MIN_TICKS: 4,
          LIQ_BUFFER_MAX_TICKS: 30,
          AVOID_ROUND_LEVELS: true,
          ROUND_LEVEL_STEP: 50,
        },
        ltp: 110,
        atrPts: 5,
        tickSize: 0.05,
      },
    });

    expect(out.anchorType).toBe('ORB_BREAKOUT');
    expect(out.anchorPrice).toBe(100);
    expect(out.bufferPts).toBeGreaterThan(0);
    expect(out.recommendedSL).toBeLessThan(100);
  });

  test('falls back to swing for unknown strategy', () => {
    const out = computeStopAnchor({
      strategyId: 'unknown_strategy',
      side: 'SELL',
      levels: { lastSwingHigh: 220, vwap: 210 },
      nowContext: {
        env: { STRATEGY_STOP_ANCHOR_MAP: 'breakout:ORB', LIQ_BUFFER_MIN_TICKS: 4, LIQ_BUFFER_MAX_TICKS: 30 },
        ltp: 200,
        atrPts: 4,
        tickSize: 0.05,
      },
    });
    expect(out.anchorType).toBe('SWING_HIGH');
    expect(out.recommendedSL).toBeGreaterThan(220);
  });
});
