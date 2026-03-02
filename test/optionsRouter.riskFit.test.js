jest.mock('../src/instruments/instrumentRepo', () => ({
  getInstrumentsDump: jest.fn(),
  parseCsvList: (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean),
  uniq: (arr) => Array.from(new Set(arr)),
}));

jest.mock('../src/fno/optionChainCache', () => ({
  getOptionChainSnapshot: jest.fn(),
  setLastOptionPick: jest.fn(),
}));

const { env } = require('../src/config');
const { pickOptionContractForSignal } = require('../src/fno/optionsRouter');
const { getInstrumentsDump } = require('../src/instruments/instrumentRepo');
const { getOptionChainSnapshot } = require('../src/fno/optionChainCache');

function mkRow({ strike, ltp, delta = 0.5, token, lotSize = 50 }) {
  return {
    name: 'NIFTY',
    instrument_type: 'CE',
    exchange: 'NFO',
    tradingsymbol: `NIFTY${strike}CE`,
    strike,
    lot_size: lotSize,
    tick_size: 0.05,
    expiry: '2026-01-08',
    instrument_token: token,
    ltp,
    spread_bps: 10,
    depth_qty_top: 100,
    volume: 1000,
    oi: 2000,
    delta,
    gamma: 0.001,
    iv_pts: 20,
    health_score: 90,
    book_flicker: 0,
  };
}

describe('optionsRouter risk fit fallbacks', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    env.OPT_PICK_REQUIRE_OK = true;
    env.OPT_PREMIUM_BAND_ENFORCE_NIFTY = false;
    env.OPT_RISK_FIT_ENABLED = true;
    env.OPT_RISK_FIT_CONFIDENCE_HIGH = 80;
    env.OPT_RISK_FIT_ALLOW_LOW_PREMIUM_FALLBACK = true;
    env.OPT_LOW_PREMIUM_MIN_DELTA = 0.15;
    env.OPT_LOW_PREMIUM_MIN_PREMIUM = 8;
    env.OPT_ONE_LOT_OVERBUDGET_MAX_MULT = 1.25;
    env.OPT_LIQ_GATE_ENABLED = false;
    env.OPT_DELTA_BAND_ENFORCE = false;
    env.OPT_PICK_REQUIRE_OK = false;
    env.OPT_ATM_SCAN_STEPS = 2;
    env.OPT_STRICT_ATM_ONLY = false;
    env.OPT_MIN_PREMIUM_NIFTY = 0;
    env.OPT_MAX_PREMIUM_NIFTY = 1000;
  });

  test('high confidence picks lower premium contract that fits risk', async () => {
    const rows = [mkRow({ strike: 22000, ltp: 200, token: 1 }), mkRow({ strike: 22050, ltp: 60, delta: 0.2, token: 2, lotSize: 25 })];
    getInstrumentsDump.mockResolvedValue(rows);
    getOptionChainSnapshot.mockResolvedValue({ snapshot: { rows } });
    const out = await pickOptionContractForSignal({
      kite: {}, universe: { universe: { contracts: { NIFTY: { instrument_token: 1, tradingsymbol: 'NIFTY 50', name: 'NIFTY' } } } }, underlyingToken: 1, underlyingTradingsymbol: 'NIFTY 50', side: 'BUY', underlyingLtp: 22010,
      riskTradeInr: 500, stopDistancePts: 12, confidence: 90,
    });
    expect(out.instrument_token).toBe(2);
    expect(out.meta.riskFit.oneLotOverbudgetAllowed).toBe(false);
  });

  test('high confidence allows bounded one-lot overbudget', async () => {
    const rows = [mkRow({ strike: 22000, ltp: 200, token: 11 }), mkRow({ strike: 22050, ltp: 150, delta: 0.25, token: 12 })];
    getInstrumentsDump.mockResolvedValue(rows);
    getOptionChainSnapshot.mockResolvedValue({ snapshot: { rows } });
    const out = await pickOptionContractForSignal({
      kite: {}, universe: { universe: { contracts: { NIFTY: { instrument_token: 1, tradingsymbol: 'NIFTY 50', name: 'NIFTY' } } } }, underlyingToken: 1, underlyingTradingsymbol: 'NIFTY 50', side: 'BUY', underlyingLtp: 22010,
      riskTradeInr: 500, stopDistancePts: 11, confidence: 90,
    });
    expect(out.instrument_token).toBe(11);
    expect(out.meta.riskFit.oneLotOverbudgetAllowed).toBe(true);
  });

  test('non-high confidence skips when no contract can fit risk', async () => {
    const rows = [mkRow({ strike: 22000, ltp: 200, token: 21 }), mkRow({ strike: 22050, ltp: 150, delta: 0.25, token: 22 })];
    getInstrumentsDump.mockResolvedValue(rows);
    getOptionChainSnapshot.mockResolvedValue({ snapshot: { rows } });
    const out = await pickOptionContractForSignal({
      kite: {}, universe: { universe: { contracts: { NIFTY: { instrument_token: 1, tradingsymbol: 'NIFTY 50', name: 'NIFTY' } } } }, underlyingToken: 1, underlyingTradingsymbol: 'NIFTY 50', side: 'BUY', underlyingLtp: 22010,
      riskTradeInr: 200, stopDistancePts: 12, confidence: 60,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('NO_CONTRACT_CAN_FIT_RISK');
  });
});
