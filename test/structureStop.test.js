const { computeStructureStopFloor } = require('../src/trading/structureStop');

function bars(closes, highs = null, lows = null) {
  return closes.map((c, i) => ({
    close: c,
    high: highs ? highs[i] : c + 0.5,
    low: lows ? lows[i] : c - 0.5,
  }));
}

const env = {
  VWAP_ENABLED: 'true',
  VWAP_CONFIRM_MODE: 'CLOSE',
  VWAP_CONFIRM_BARS: 1,
  ORB_ENABLED: 'true',
  ORB_CONFIRM_MODE: 'CLOSE',
  ORB_CONFIRM_BARS: 1,
  DAY_LEVELS_ENABLED: 'true',
  PREV_DAY_LEVELS_ENABLED: 'false',
  WEEK_LEVELS_ENABLED: 'false',
  ANCHOR_BUFFER_TICKS: 2,
  ANCHOR_MIN_GAP_ATR_MULT: 0.3,
  ANCHOR_MIN_GAP_TICKS: 10,
  ANCHOR_PRIORITY: 'VWAP,ORB,DAY,PREV_DAY,WEEK',
};

describe('structureStop', () => {
  test('BUY breakout above ORB produces anchor stop', () => {
    const out = computeStructureStopFloor({
      side: 'BUY',
      ltp: 110,
      peakLtp: 112,
      tick: 0.05,
      atrPts: 6,
      levels: { orbHigh: 100 },
      candles: bars([111]),
      env,
    });
    expect(out.ok).toBe(true);
    expect(out.structureStop).toBeCloseTo(99.9, 6);
  });

  test('VWAP reclaim chooses vwap-buffer when confirmed', () => {
    const out = computeStructureStopFloor({
      side: 'BUY',
      ltp: 108,
      peakLtp: 110,
      tick: 0.05,
      atrPts: 5,
      levels: { vwap: 105 },
      candles: bars([106, 106.5]),
      env,
    });
    expect(out.ok).toBe(true);
    expect(out.chosen.type).toBe('VWAP');
    expect(out.structureStop).toBeCloseTo(104.9, 6);
  });

  test('too tight candidate is invalidated', () => {
    const out = computeStructureStopFloor({
      side: 'BUY',
      ltp: 112,
      peakLtp: 112,
      tick: 0.05,
      atrPts: 6,
      levels: { dayHigh: 111.8 },
      candles: bars([112.1]),
      env,
    });
    expect(out.ok).toBe(false);
    expect(out.candidates.some((c) => c.why === 'too_tight_vs_atr')).toBe(true);
  });
});
