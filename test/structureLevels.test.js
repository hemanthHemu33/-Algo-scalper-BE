const { computeStructureLevels } = require('../src/trading/structureLevels');

function c(ts, o, h, l, cl, v = 100) {
  return { timestamp: ts, open: o, high: h, low: l, close: cl, volume: v };
}

describe('structureLevels', () => {
  test('computes day/ORB hi-lo and vwap', () => {
    const dayOpen = Date.UTC(2026, 1, 2, 3, 45); // 09:15 IST
    const candles = [
      c(dayOpen + 0 * 60000, 100, 102, 99, 101, 100),
      c(dayOpen + 5 * 60000, 101, 103, 100, 102, 100),
      c(dayOpen + 10 * 60000, 102, 104, 101, 103, 100),
      c(dayOpen + 20 * 60000, 103, 106, 102, 105, 100),
    ];
    const out = computeStructureLevels({
      candles,
      tz: 'Asia/Kolkata',
      nowTs: dayOpen + 25 * 60000,
      sessionOpenTs: dayOpen,
      orbMinutes: 15,
      env: { STRUCTURE_CANDLE_LIMIT: 800 },
    });

    expect(out.ok).toBe(true);
    expect(out.dayHigh).toBe(106);
    expect(out.dayLow).toBe(99);
    expect(out.orbHigh).toBe(104);
    expect(out.orbLow).toBe(99);
    const expectedVwap = ((100.6666667 * 100) + (101.6666667 * 100) + (102.6666667 * 100) + (104.3333333 * 100)) / 400;
    expect(out.vwap).toBeCloseTo(expectedVwap, 4);
  });
});
