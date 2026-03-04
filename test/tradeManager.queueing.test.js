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



  test('queueSignal resets entryInFlight even when trade becomes active', async () => {
    const tm = makeTradeManager();
    tm._handleSignal = jest.fn(async () => {
      tm.activeTradeId = 'T1';
      return { ok: true };
    });

    await tm.queueSignal({
      instrument_token: 123,
      side: 'BUY',
      strategyId: 'x',
      signalTs: Date.now(),
    });

    expect(tm.activeTradeId).toBe('T1');
    expect(tm._entryInFlight).toBe(false);
  });

  test('blind-exit reconcile escalation uses queueReconcile, not direct handle', async () => {
    const tm = makeTradeManager();
    tm.queueReconcile = jest.fn(() => Promise.resolve({ ok: true }));
    tm._handleReconcile = jest.fn(() => Promise.resolve({ ok: true }));

    const trade = { tradeId: 'T1', status: 'LIVE' };
    await tm._handleBlindExitEngine(trade);
    await tm._handleBlindExitEngine(trade);
    await tm._handleBlindExitEngine(trade);

    expect(tm.queueReconcile).toHaveBeenCalledWith([], 'dyn_exit_reconcile');
    expect(tm._handleReconcile).not.toHaveBeenCalled();
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
