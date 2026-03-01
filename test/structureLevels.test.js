const { computeStructureLevels } = require('../src/trading/structureLevels');

function c(ts, o, h, l, cl, v = 100) {
  return { timestamp: ts, open: o, high: h, low: l, close: cl, volume: v };
}

describe('structureLevels', () => {
  test('computes day/prevday/week(5 sessions)/ORB/vwap/swings', () => {
    const dayOpen = Date.UTC(2026, 1, 6, 3, 45); // 09:15 IST
    const d = 24 * 60 * 60 * 1000;
    const candles = [];
    for (let i = 5; i >= 0; i -= 1) {
      const open = dayOpen - i * d;
      candles.push(c(open + 0 * 60000, 100 + i, 103 + i, 99 + i, 101 + i, 100));
      candles.push(c(open + 5 * 60000, 101 + i, 104 + i, 100 + i, 103 + i, 120));
      candles.push(c(open + 10 * 60000, 102 + i, 105 + i, 98 + i, 104 + i, 140));
    }

    const out = computeStructureLevels({
      env: { ORB_MINUTES: 15, VWAP_ENABLED: true, SWING_LOOKBACK: 20 },
      tz: 'Asia/Kolkata',
      nowMs: dayOpen + 20 * 60000,
      underlyingCandles: candles,
      sessionOpenTs: dayOpen,
    });

    expect(out.meta.ok).toBe(true);
    expect(out.dayHigh).toBe(105);
    expect(out.dayLow).toBe(98);
    expect(out.prevDayHigh).toBe(106);
    expect(out.prevDayLow).toBe(99);
    expect(out.weekHigh).toBeGreaterThanOrEqual(105);
    expect(out.weekLow).toBeLessThanOrEqual(98);
    expect(out.orbHigh).toBe(105);
    expect(out.orbLow).toBe(98);
    expect(out.vwap).toBeGreaterThan(100);
    expect(out).toHaveProperty('lastSwingHigh');
    expect(out).toHaveProperty('lastSwingLow');
  });
});
