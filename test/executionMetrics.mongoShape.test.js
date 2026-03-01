jest.mock('../src/db', () => ({ getDb: jest.fn() }));

const { getDb } = require('../src/db');
const { recordEntryFill } = require('../src/execution/executionMetrics');

describe('executionMetrics Mongo return shape compatibility', () => {
  test('uses res.value when present', async () => {
    const findOneAndUpdate = jest.fn().mockResolvedValue({
      value: { date: '2025-01-15', symbol: 'NIFTY', entryCount: 1, entrySlipPtsSum: 2 },
    });
    const findOne = jest.fn();
    const updateOne = jest.fn().mockResolvedValue({ acknowledged: true });

    getDb.mockReturnValue({
      collection: () => ({ findOneAndUpdate, findOne, updateOne }),
    });

    const out = await recordEntryFill({ dateKey: '2025-01-15', symbol: 'NIFTY', slipPts: 2 });
    expect(out.avgEntrySlipPts).toBeCloseTo(2, 6);
    expect(findOne).not.toHaveBeenCalled();
  });

  test('falls back to findOne when res.value is null', async () => {
    const findOneAndUpdate = jest.fn().mockResolvedValue({ value: null });
    const findOne = jest.fn().mockResolvedValue({
      date: '2025-01-15',
      symbol: 'BANKNIFTY',
      entryCount: 3,
      entrySlipPtsSum: 6,
      exitCount: 1,
      exitSlipPtsSum: 1,
    });
    const updateOne = jest.fn().mockResolvedValue({ acknowledged: true });

    getDb.mockReturnValue({
      collection: () => ({ findOneAndUpdate, findOne, updateOne }),
    });

    const out = await recordEntryFill({ dateKey: '2025-01-15', symbol: 'BANKNIFTY', slipPts: 1 });
    expect(findOne).toHaveBeenCalledWith({ date: '2025-01-15', symbol: 'BANKNIFTY' });
    expect(out.avgEntrySlipPts).toBeCloseTo(2, 6);
  });
});
