class CandleCache {
  constructor({ maxCandles = 800 } = {}) {
    this.maxCandles = Math.max(1, Number(maxCandles) || 800);
    this.cache = new Map();
  }

  _key(token, intervalMin) {
    return `${Number(token)}:${Number(intervalMin)}`;
  }

  _ensureList(key) {
    if (!this.cache.has(key)) this.cache.set(key, []);
    return this.cache.get(key);
  }

  addCandle(candle) {
    if (!candle || !candle.ts) return;
    const token = Number(candle.instrument_token);
    const intervalMin = Number(candle.interval_min);
    if (!Number.isFinite(token) || !Number.isFinite(intervalMin)) return;

    const ts = new Date(candle.ts);
    if (!Number.isFinite(ts.getTime())) return;

    const key = this._key(token, intervalMin);
    const arr = this._ensureList(key);

    if (!arr.length) {
      arr.push(candle);
    } else {
      const last = arr[arr.length - 1];
      const lastTs = new Date(last.ts).getTime();
      const curTs = ts.getTime();

      if (curTs > lastTs) {
        arr.push(candle);
      } else if (curTs === lastTs) {
        arr[arr.length - 1] = candle;
      } else {
        let idx = arr.findIndex(
          (existing) => new Date(existing.ts).getTime() > curTs,
        );
        if (idx === -1) idx = arr.length;
        if (
          idx > 0 &&
          new Date(arr[idx - 1].ts).getTime() === curTs
        ) {
          arr[idx - 1] = candle;
        } else if (idx < arr.length) {
          arr.splice(idx, 0, candle);
        } else {
          arr.push(candle);
        }
      }
    }

    if (arr.length > this.maxCandles) {
      arr.splice(0, arr.length - this.maxCandles);
    }
  }

  addCandles(candles) {
    for (const candle of candles || []) {
      this.addCandle(candle);
    }
  }

  getCandles(token, intervalMin, limit) {
    const key = this._key(token, intervalMin);
    const arr = this.cache.get(key);
    if (!arr || !arr.length) return [];
    if (!limit) return arr.slice();
    const lim = Math.max(1, Number(limit) || arr.length);
    return arr.slice(-lim);
  }
}

module.exports = { CandleCache };
