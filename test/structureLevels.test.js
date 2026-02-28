const { computeStructureLevels } = require('../src/trading/structureLevels');

function c(ts, o, h, l, cl, v = 100) {
  return { timestamp: ts, open: o, high: h, low: l, close: cl, volume: v };
}

describe('structureLevels', () => {
  test('computes day/prevday/week/ORB/vwap + swings', () => {
    const dayOpen = Date.UTC(2026, 1, 2, 3, 45); // 09:15 IST
    const prevOpen = dayOpen - 24 * 60 * 60 * 1000;
    const candles = [
      c(prevOpen + 0 * 60000, 95, 98, 94, 97, 100),
      c(prevOpen + 5 * 60000, 97, 99, 96, 98, 100),
      c(dayOpen + 0 * 60000, 100, 102, 99, 101, 100),
      c(dayOpen + 5 * 60000, 101, 103, 100, 102, 100),
      c(dayOpen + 10 * 60000, 102, 104, 101, 103, 100),
      c(dayOpen + 15 * 60000, 103, 105, 102, 104, 100),
      c(dayOpen + 20 * 60000, 104, 104.5, 102.5, 103.5, 100),
      c(dayOpen + 25 * 60000, 103.5, 106, 103, 105, 100),
    ];
    const out = computeStructureLevels({
      env: { ORB_MINUTES: 15 },
      tz: 'Asia/Kolkata',
      nowMs: dayOpen + 25 * 60000,
      underlyingCandles: candles,
      sessionOpenTs: dayOpen,
    });

    expect(out.meta.ok).toBe(true);
    expect(out.dayHigh).toBe(106);
    expect(out.dayLow).toBe(99);
    expect(out.prevDayHigh).toBe(99);
    expect(out.prevDayLow).toBe(94);
    expect(out.weekHigh).toBe(106);
    expect(out.weekLow).toBe(99);
    expect(out.orbHigh).toBe(105);
    expect(out.orbLow).toBe(99);
    expect(out.vwap).toBeGreaterThan(100);
    expect(out).toHaveProperty("swingHL");
    expect(out).toHaveProperty("swingLH");
  });
});
