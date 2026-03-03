jest.mock('../src/db', () => ({ getDb: jest.fn() }));
jest.mock('../src/tokenStore', () => ({ readLatestTokenDoc: jest.fn() }));
jest.mock('../src/alerts/alertService', () => ({ alert: jest.fn().mockResolvedValue(undefined) }));

const { getDb } = require('../src/db');
const { readLatestTokenDoc } = require('../src/tokenStore');
const { watchLatestToken } = require('../src/tokenWatcher');

describe('tokenWatcher resilience', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getDb.mockReturnValue({
      collection: () => ({
        watch: () => ({ on: jest.fn(), close: jest.fn().mockResolvedValue(undefined) }),
      }),
    });
  });

  test('does not throw when token is missing and callbacks are absent', async () => {
    readLatestTokenDoc.mockResolvedValue({ accessToken: null, reason: 'NO_TOKEN_DOC', doc: null });
    await expect(watchLatestToken({})).resolves.toEqual(expect.any(Function));
  });

  test('does not throw when token read fails or callback throws', async () => {
    readLatestTokenDoc.mockRejectedValue(new Error('db temporary error'));
    const onMissing = jest.fn().mockRejectedValue(new Error('callback error'));

    await expect(watchLatestToken({ onMissing })).resolves.toEqual(expect.any(Function));
    expect(onMissing).toHaveBeenCalled();
  });
});
