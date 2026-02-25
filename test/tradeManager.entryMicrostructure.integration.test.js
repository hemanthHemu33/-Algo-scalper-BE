const { TradeManager } = require('../src/trading/tradeManager');
const { env } = require('../src/config');

describe('TradeManager IOC lifecycle integration', () => {
  const originalEnv = {};
  const envKeys = [
    'DEFAULT_PRODUCT',
    'DEFAULT_ORDER_VARIETY',
    'ENTRY_AGGRESSIVE_VALIDITY',
    'ENTRY_PASSIVE_VALIDITY',
    'ENTRY_IOC_BASE_BUFFER_TICKS',
    'ENTRY_IOC_BASE_BUFFER_TICKS_OPT',
    'ENTRY_LADDER_MAX_CHASE_BPS',
    'ENTRY_LADDER_MAX_CHASE_BPS_OPT',
    'ENTRY_LADDER_TICKS',
    'ENTRY_LADDER_STEP_DELAY_MS',
    'ENTRY_LIMIT_FALLBACK_TO_MARKET',
    'ENTRY_PASSIVE_MAX_SPREAD_BPS',
    'ENTRY_AGGRESSIVE_MAX_SPREAD_BPS',
    'ENTRY_PASSIVE_MAX_SPREAD_BPS_OPT',
    'ENTRY_AGGRESSIVE_MAX_SPREAD_BPS_OPT',
    'ENTRY_MARKET_FALLBACK_MAX_SPREAD_BPS_OPT',
  ];

  beforeAll(() => {
    for (const key of envKeys) originalEnv[key] = env[key];
  });

  afterEach(() => {
    for (const key of envKeys) env[key] = originalEnv[key];
  });

  function buildTm() {
    return new TradeManager({
      kite: {},
      riskEngine: {
        setStateChangeHandler: jest.fn(),
      },
    });
  }

  test('retries unmatched IOC then falls back to market when enabled', async () => {
    const tm = buildTm();
    env.DEFAULT_PRODUCT = 'MIS';
    env.DEFAULT_ORDER_VARIETY = 'regular';
    env.ENTRY_LADDER_TICKS = 1;
    env.ENTRY_IOC_BASE_BUFFER_TICKS = 1;
    env.ENTRY_LADDER_MAX_CHASE_BPS = 50;
    env.ENTRY_LADDER_STEP_DELAY_MS = 0;
    env.ENTRY_LIMIT_FALLBACK_TO_MARKET = 'true';
    env.ENTRY_PASSIVE_MAX_SPREAD_BPS = 1;
    env.ENTRY_AGGRESSIVE_MAX_SPREAD_BPS = 30;

    tm._getBestBidAsk = jest
      .fn()
      .mockResolvedValue({ bid: 99.95, ask: 100, ltp: 100, hasDepth: true });

    const placed = [];
    tm._safePlaceOrder = jest.fn(async (_variety, params) => {
      placed.push(params);
      return { orderId: `oid-${placed.length}` };
    });

    tm._getOrderStatus = jest.fn(async (orderId) => ({
      status: 'CANCELLED',
      order: {
        order_id: orderId,
        status: 'CANCELLED',
        status_message_raw: 'IOC unmatched and cancelled by the system',
        filled_quantity: 0,
      },
    }));

    const out = await tm._executeEntryByMicrostructure({
      tradeId: 'T-1',
      instrument: { exchange: 'NSE', tradingsymbol: 'ABC', instrument_token: 1, tick_size: 0.05 },
      side: 'BUY',
      qty: 10,
      expectedEntryPrice: 100,
      segment: 'EQ',
    });

    expect(out.ok).toBe(true);
    expect(out.policy).toBe('FALLBACK_MARKET');
    expect(placed).toHaveLength(3);
    expect(placed[0]).toMatchObject({ order_type: 'LIMIT', validity: 'IOC', price: 100.05 });
    expect(placed[1]).toMatchObject({ order_type: 'LIMIT', validity: 'IOC', price: 100.1 });
    expect(placed[2]).toMatchObject({ order_type: 'MARKET', validity: 'DAY' });
  });

  test('uses OMS status/cancel codes for unmatched detection and succeeds on retry', async () => {
    const tm = buildTm();
    env.DEFAULT_PRODUCT = 'MIS';
    env.DEFAULT_ORDER_VARIETY = 'regular';
    env.ENTRY_LADDER_TICKS = 2;
    env.ENTRY_IOC_BASE_BUFFER_TICKS = 1;
    env.ENTRY_LADDER_MAX_CHASE_BPS = 50;
    env.ENTRY_LADDER_STEP_DELAY_MS = 0;
    env.ENTRY_LIMIT_FALLBACK_TO_MARKET = 'false';
    env.ENTRY_PASSIVE_MAX_SPREAD_BPS = 1;
    env.ENTRY_AGGRESSIVE_MAX_SPREAD_BPS = 30;

    tm._getBestBidAsk = jest
      .fn()
      .mockResolvedValue({ bid: 199.9, ask: 200, ltp: 199.95, hasDepth: true });

    const placed = [];
    tm._safePlaceOrder = jest.fn(async (_variety, params) => {
      placed.push(params);
      return { orderId: `oid-${placed.length}` };
    });

    tm._getOrderStatus = jest.fn(async (orderId) => {
      if (orderId === 'oid-1') {
        return {
          status: 'CANCELLED',
          order: {
            order_id: orderId,
            status: 'CANCELLED',
            status_message_raw: 'cancelled',
            cancel_reason_code: 'IOC_UNMATCHED',
            filled_quantity: 0,
          },
        };
      }
      return {
        status: 'COMPLETE',
        order: { order_id: orderId, status: 'COMPLETE', filled_quantity: 10 },
      };
    });

    const out = await tm._executeEntryByMicrostructure({
      tradeId: 'T-2',
      instrument: { exchange: 'NSE', tradingsymbol: 'XYZ', instrument_token: 2, tick_size: 0.05 },
      side: 'BUY',
      qty: 10,
      expectedEntryPrice: 200,
      segment: 'EQ',
    });

    expect(out.ok).toBe(true);
    expect(out.policy).toBe('AGGRESSIVE');
    expect(out.iocAttempt).toBe(2);
    expect(placed).toHaveLength(2);
    expect(placed.every((x) => x.order_type === 'LIMIT')).toBe(true);
  });

  test('applies OPT-specific IOC buffer/chase thresholds', async () => {
    const tm = buildTm();
    env.DEFAULT_PRODUCT = 'MIS';
    env.DEFAULT_ORDER_VARIETY = 'regular';
    env.ENTRY_LADDER_TICKS = 0;
    env.ENTRY_IOC_BASE_BUFFER_TICKS = 1;
    env.ENTRY_IOC_BASE_BUFFER_TICKS_OPT = 3;
    env.ENTRY_LADDER_MAX_CHASE_BPS = 35;
    env.ENTRY_LADDER_MAX_CHASE_BPS_OPT = 5;
    env.ENTRY_LIMIT_FALLBACK_TO_MARKET = 'false';
    env.ENTRY_PASSIVE_MAX_SPREAD_BPS_OPT = 1;
    env.ENTRY_AGGRESSIVE_MAX_SPREAD_BPS_OPT = 60;

    tm._getBestBidAsk = jest
      .fn()
      .mockResolvedValue({ bid: 99.95, ask: 100, ltp: 100, hasDepth: true });

    tm._safePlaceOrder = jest.fn();
    tm._getOrderStatus = jest.fn();

    const out = await tm._executeEntryByMicrostructure({
      tradeId: 'T-3',
      instrument: { exchange: 'NFO', tradingsymbol: 'OPT1', instrument_token: 3, tick_size: 0.05 },
      side: 'BUY',
      qty: 50,
      expectedEntryPrice: 100,
      segment: 'OPT',
    });

    expect(out.ok).toBe(false);
    expect(out.reason).toBe('chase_cap');
    expect(out.chaseBps).toBeGreaterThan(5);
    expect(tm._safePlaceOrder).not.toHaveBeenCalled();
  });
});
