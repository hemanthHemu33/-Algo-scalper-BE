const { TradeManager, STATUS: TM_STATUS } = require('../src/trading/tradeManager');
const { STATUS: FSM_STATUS } = require('../src/trading/tradeStateMachine');

function makeTradeManager() {
  return new TradeManager({
    kite: {},
    riskEngine: {
      setStateChangeHandler: () => {},
      tradesToday: 0,
      getKillSwitch: () => false,
    },
  });
}

describe('TradeManager op queueing', () => {
  test('queueSignal sets entryInFlight immediately and blocks second signal', async () => {
    const tm = makeTradeManager();
    const seen = [];
    tm._handleSignal = jest.fn(async (signal) => {
      seen.push(signal.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true };
    });

    const sig1 = { id: 's1', instrument_token: 123, side: 'BUY', strategyId: 'x', signalTs: Date.now() };
    const sig2 = { id: 's2', instrument_token: 123, side: 'BUY', strategyId: 'x', signalTs: Date.now() + 1 };

    const p1 = tm.queueSignal(sig1);
    expect(tm._entryInFlight).toBe(true);

    const second = await tm.queueSignal(sig2);
    expect(second).toEqual({ ok: false, reason: 'busy' });

    await p1;
    expect(tm._handleSignal).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['s1']);
    expect(tm._entryInFlight).toBe(false);
  });

  test('queueOrderUpdate serializes calls without overlap', async () => {
    const tm = makeTradeManager();
    const orderSeen = [];
    let inProgress = false;

    tm._handleOrderUpdate = jest.fn(async (order) => {
      if (inProgress) throw new Error('overlap');
      inProgress = true;
      orderSeen.push(order.order_id);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inProgress = false;
    });

    await Promise.all([
      tm.queueOrderUpdate({ order_id: 'o1' }),
      tm.queueOrderUpdate({ order_id: 'o2' }),
    ]);

    expect(tm._handleOrderUpdate).toHaveBeenCalledTimes(2);
    expect(orderSeen).toEqual(['o1', 'o2']);
  });

  test('TradeManager uses STATUS from tradeStateMachine', () => {
    expect(TM_STATUS).toBe(FSM_STATUS);
    expect(TM_STATUS.ENTRY_OPEN).toBe('ENTRY_OPEN');
  });
});
