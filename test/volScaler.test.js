const { computeVolScaler, applyScalerToRThreshold } = require('../src/trading/volScaler');

describe('volScaler', () => {
  test('computes bounded scaler', () => {
    const env = { VOL_TARGET_BPS: 65, VOL_SCALER_MIN: 0.8, VOL_SCALER_MAX: 1.3 };
    expect(computeVolScaler({ env, atrBps: 130 })).toBeCloseTo(0.8, 4);
    expect(computeVolScaler({ env, atrBps: 40 })).toBeCloseTo(1.3, 4);
    expect(computeVolScaler({ env, atrBps: 65 })).toBeCloseTo(1, 4);
  });

  test('applies scaler only when flag enabled', () => {
    expect(applyScalerToRThreshold(0.6, 0.9, true)).toBeCloseTo(0.54, 6);
    expect(applyScalerToRThreshold(0.6, 0.9, false)).toBeCloseTo(0.6, 6);
  });
});
