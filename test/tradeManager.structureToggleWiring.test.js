jest.mock('../src/market/candleStore', () => ({
  getRecentCandles: jest.fn(),
}));

jest.mock('../src/trading/dynamicExitManager', () => ({
  computeDynamicExitPlan: jest.fn(() => ({ ok: false })),
}));

jest.mock('../src/trading/tradeStore', () => ({
  ensureTradeIndexes: jest.fn(),
  insertTrade: jest.fn(),
  updateTrade: jest.fn(),
  getTrade: jest.fn(),
  getActiveTrades: jest.fn(),
  linkOrder: jest.fn(),
  findTradeByOrder: jest.fn(),
  saveOrphanOrderUpdate: jest.fn(),
  popOrphanOrderUpdates: jest.fn(),
  deadLetterOrphanOrderUpdates: jest.fn(),
  appendOrderLog: jest.fn(),
  upsertLiveOrderSnapshot: jest.fn(),
  getLiveOrderSnapshotsByTradeIds: jest.fn(),
  upsertDailyRisk: jest.fn(),
  getDailyRisk: jest.fn(),
  upsertRiskState: jest.fn(),
  getRiskState: jest.fn(),
}));

const { TradeManager } = require('../src/trading/tradeManager');
const { env } = require('../src/config');
const { getRecentCandles } = require('../src/market/candleStore');

describe('TradeManager structure toggle wiring', () => {
  const snapshot = {};
  const keys = [
    'DYNAMIC_EXITS_ENABLED',
    'STRUCTURE_ANCHORS_ENABLED',
    'STRUCTURE_EXIT_ENABLED',
    'STRUCTURE_SOURCE',
    'STRUCTURE_CACHE_REFRESH_MS',
    'STRUCTURE_CANDLE_LIMIT',
  ];

  beforeAll(() => {
    keys.forEach((k) => {
      snapshot[k] = env[k];
    });
  });

  afterEach(() => {
    keys.forEach((k) => {
      env[k] = snapshot[k];
    });
    jest.clearAllMocks();
  });

  test('uses STRUCTURE_ANCHORS_ENABLED to fetch underlying candles in OPT mode', async () => {
    env.DYNAMIC_EXITS_ENABLED = 'true';
    env.STRUCTURE_ANCHORS_ENABLED = 'true';
    env.STRUCTURE_EXIT_ENABLED = 'false';
    env.STRUCTURE_SOURCE = 'UNDERLYING';
    env.STRUCTURE_CACHE_REFRESH_MS = 0;
    env.STRUCTURE_CANDLE_LIMIT = 150;

    getRecentCandles
      .mockResolvedValueOnce([{ close: 100 }])
      .mockResolvedValueOnce([{ close: 200 }]);

    const tm = new TradeManager({
      kite: {},
      riskEngine: { setStateChangeHandler: jest.fn() },
    });
    tm._getLtp = jest.fn().mockResolvedValue(101);
    tm._resolveEntryFactsForActiveTrade = jest.fn().mockResolvedValue({
      avgPrice: 100,
      filledQty: 50,
      fillTime: Date.now(),
      source: 'mock',
    });

    await tm._maybeDynamicAdjustExits(
      {
        tradeId: 'T-STRUCT-1',
        status: 'LIVE',
        side: 'BUY',
        instrument_token: 9001,
        underlying_token: 100,
        slOrderId: 'SL-1',
        targetOrderId: 'TG-1',
        intervalMin: 1,
        entryPrice: 100,
        qty: 50,
        stopLoss: 95,
        initialStopLoss: 95,
        instrument: { segment: 'NFO-OPT', tick_size: 0.05, tradingsymbol: 'MOCKOPT' },
      },
      new Map(),
    );

    expect(getRecentCandles).toHaveBeenCalledWith(9001, 1, 260);
    expect(getRecentCandles).toHaveBeenCalledWith(100, 1, 150);
  });
});
