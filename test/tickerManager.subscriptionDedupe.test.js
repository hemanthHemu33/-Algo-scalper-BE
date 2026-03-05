const tickerManager = require('../src/kite/tickerManager');

describe('tickerManager subscription dedupe', () => {
  beforeEach(() => {
    tickerManager.__resetSubscriptionStateForTests();
  });

  test('subscribe called twice does not increase unique token list', () => {
    const first = tickerManager.__dedupeNewTokensForTests([101, 101, 102]);
    expect(first).toEqual([101, 102]);

    tickerManager.__setSubscribedTokensForTests(first);
    const second = tickerManager.__dedupeNewTokensForTests([101, 102, 103]);
    expect(second).toEqual([103]);
  });
});
