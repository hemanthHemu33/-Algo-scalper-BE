const { computeVolScaler, applyScalerToRThreshold } = require('../src/trading/volScaler');

describe('volScaler', () => {
  test('computes bounded scaler from ATR/target', () => {
    const env = { VOL_ATR_TARGET_PTS: 18, VOL_SCALER_MIN: 0.8, VOL_SCALER_MAX: 1.3 };
    expect(computeVolScaler({ env, atrPts: 9 })).toBeCloseTo(0.8, 4);
    expect(computeVolScaler({ env, atrPts: 25 })).toBeCloseTo(1.3, 4);
    expect(computeVolScaler({ env, atrPts: 18 })).toBeCloseTo(1, 4);
  });

  test('applies scaler only when flag enabled', () => {
    expect(applyScalerToRThreshold(0.6, 1.1, true)).toBeCloseTo(0.66, 6);
    expect(applyScalerToRThreshold(0.6, 1.1, false)).toBeCloseTo(0.6, 6);
  });
});
