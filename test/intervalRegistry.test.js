const intervalRegistry = require('../src/utils/intervalRegistry');

describe('intervalRegistry', () => {
  afterEach(() => {
    intervalRegistry.stopAll();
  });

  test('prevents duplicate timer start for same name', () => {
    const fn = jest.fn();
    const first = intervalRegistry.start('dup.timer', fn, 1000, { unref: false });
    const second = intervalRegistry.start('dup.timer', fn, 1000, { unref: false });
    expect(first).toBe(second);
    expect(Object.keys(intervalRegistry.snapshot()).filter((k) => k === 'dup.timer')).toHaveLength(1);
  });
});
