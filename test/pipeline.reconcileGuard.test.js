const { env } = require('../src/config');
const { buildPipeline } = require('../src/pipeline');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('pipeline reconcile in-flight guards', () => {
  test('reconcile skips while prior reconcile is still in flight', async () => {
    env.CANDLE_TIMER_FINALIZER_ENABLED = 'false';

    const first = deferred();
    const trader = {
      init: jest.fn(async () => {}),
      setRuntimeAddTokens: jest.fn(),
      status: jest.fn(() => ({ ok: true })),
      onTick: jest.fn(),
      shutdown: jest.fn(async () => {}),
      queueReconcile: jest.fn(() => first.promise),
      queuePositionFirstReconcile: jest.fn(async () => ({ ok: true })),
    };

    const pipeline = buildPipeline({
      kite: {},
      tradeManagerFactory: () => trader,
    });

    const p1 = pipeline.reconcile();
    const p2 = await pipeline.reconcile();

    expect(p2).toEqual({ ok: false, skipped: true, reason: 'in_flight' });
    expect(trader.queueReconcile).toHaveBeenCalledTimes(1);

    first.resolve({ ok: true });
    await p1;

    await pipeline.reconcile();
    expect(trader.queueReconcile).toHaveBeenCalledTimes(2);

    await pipeline.shutdown();
  });

  test('ocoReconcile skips while prior oco reconcile is still in flight', async () => {
    env.CANDLE_TIMER_FINALIZER_ENABLED = 'false';

    const first = deferred();
    const trader = {
      init: jest.fn(async () => {}),
      setRuntimeAddTokens: jest.fn(),
      status: jest.fn(() => ({ ok: true })),
      onTick: jest.fn(),
      shutdown: jest.fn(async () => {}),
      queueReconcile: jest.fn(async () => ({ ok: true })),
      queuePositionFirstReconcile: jest.fn(() => first.promise),
    };

    const pipeline = buildPipeline({
      kite: {},
      tradeManagerFactory: () => trader,
    });

    const p1 = pipeline.ocoReconcile();
    const p2 = await pipeline.ocoReconcile();

    expect(p2).toEqual({ ok: false, skipped: true, reason: 'in_flight' });
    expect(trader.queuePositionFirstReconcile).toHaveBeenCalledTimes(1);

    first.resolve({ ok: true });
    await p1;

    await pipeline.ocoReconcile();
    expect(trader.queuePositionFirstReconcile).toHaveBeenCalledTimes(2);

    await pipeline.shutdown();
  });
});
