const { DateTime } = require("luxon");
const { logger } = require("../logger");

function isIndexTick(tick) {
  const seg = String(tick?.segment || "").toUpperCase();
  const it = String(tick?.instrument_type || "").toUpperCase();
  if (seg === "INDICES" || it === "INDEX") return true;
  // Kite index ticks are non-tradable and often have no depth ladder.
  return tick?.tradable === false && !(tick?.depth?.buy?.length || tick?.depth?.sell?.length);
}


class CandleBuilder {
  constructor({ intervalsMinutes, timezone }) {
    this.intervals = intervalsMinutes;
    this.tz = timezone;
    this.current = new Map();
    this.prevDayVolume = new Map();
    this.lastTickTs = new Map(); // key: token:interval -> last tick ts
    this._noVolWarned = new Set(); // token set
  }

  _bucketStart(ts, intervalMin) {
    const dt = DateTime.fromJSDate(ts, { zone: this.tz });
    const minute = Math.floor(dt.minute / intervalMin) * intervalMin;
    return dt.set({ second: 0, millisecond: 0, minute }).toJSDate();
  }

  onTicks(ticks) {
    const closed = [];

    for (const tick of ticks || []) {
      if (!tick || !tick.instrument_token) continue;

      const token = Number(tick.instrument_token);
      const price = Number(tick.last_price);
      if (!Number.isFinite(price)) continue;

      const ts = tick.exchange_timestamp
        ? new Date(tick.exchange_timestamp)
        : tick.last_trade_time
          ? new Date(tick.last_trade_time)
          : tick.timestamp
            ? new Date(tick.timestamp)
            : new Date();

      // Volume handling:
      // - Prefer LTQ when available
      // - Otherwise use day volume delta
      // - If day volume resets (new trading day), treat baseline as reset and use current dayVol as delta
      const ltq = Number(
        tick.last_traded_quantity ??
          tick.last_quantity ??
          tick.last_traded_qty ??
          0,
      );
      const dayVol = Number(
        tick.volume_traded ?? tick.volume ?? tick.volume_traded_today ?? 0,
      );

      // Pro-safety: if ticks have no volume fields (common in LTP mode), warn once per token.
      // Index ticks are volume-less by design, so keep this warning index-safe.
      const indexTick = isIndexTick(tick);
      if (ltq <= 0 && dayVol <= 0 && !indexTick && !this._noVolWarned.has(token)) {
        this._noVolWarned.add(token);
        logger.warn(
          {
            token,
            hint: "Set TICK_MODE_UNDERLYING=quote/full to enable volume-based confidence",
          },
          "[candle] tick has no volume fields; candle volume will stay 0",
        );
      }

      const prev = this.prevDayVolume.get(token);
      let deltaVol = 0;
      if (prev == null) {
        deltaVol = 0;
      } else if (dayVol < prev) {
        // day reset (or feed glitch) – treat current dayVol as delta (baseline reset)
        deltaVol = Math.max(0, dayVol);
      } else {
        deltaVol = Math.max(0, dayVol - prev);
      }
      this.prevDayVolume.set(token, dayVol);

      const volAdd = ltq > 0 ? ltq : deltaVol;

      for (const intervalMin of this.intervals) {
        const key = `${token}:${intervalMin}`;
        const bucketStart = this._bucketStart(ts, intervalMin);
        this.lastTickTs.set(key, ts);

        const c = this.current.get(key);
        if (!c) {
          this.current.set(
            key,
            newCandle(token, intervalMin, bucketStart, price, volAdd),
          );
          continue;
        }

        // New bucket → close previous candle and open a fresh live candle
        if (c.ts.getTime() !== bucketStart.getTime()) {
          closed.push({ ...c, closedAt: new Date() });
          this.current.set(
            key,
            newCandle(token, intervalMin, bucketStart, price, volAdd),
          );
          continue;
        }

        /**
         * ✅ FIX: Synthetic → Live flip
         * If finalizeDue() created a placeholder synthetic candle for this bucket,
         * the first real tick must convert it back to live.
         * Otherwise your strategy engine may keep blocking signals forever.
         */
        if (c.synthetic === true || c.source !== "live") {
          c.source = "live";
          c.synthetic = false;

          // If it was just a placeholder (volume 0), reset OHLC to the real first tick
          if (Number(c.volume || 0) === 0) {
            c.open = price;
            c.high = price;
            c.low = price;
            c.close = price;
          }
        }

        c.high = Math.max(c.high, price);
        c.low = Math.min(c.low, price);
        c.close = price;
        c.volume += volAdd;
      }
    }

    return closed;
  }

  getCurrentCandle(token, intervalMin) {
    const key = `${Number(token)}:${Number(intervalMin)}`;
    return this.current.get(key) || null;
  }

  finalizeDue(now = new Date(), opts = {}) {
    const graceMs = Number(opts.graceMs ?? 1500);
    const maxBars = Number(opts.maxBars ?? 3);
    const closed = [];

    for (const [key, cur] of this.current.entries()) {
      let c = cur;
      const intervalMin = Number(c.interval_min);
      const intervalMs = intervalMin * 60 * 1000;

      let bars = 0;
      while (bars < maxBars) {
        const nowBucket = this._bucketStart(now, intervalMin);

        // still inside current bucket -> nothing to do
        if (c.ts.getTime() === nowBucket.getTime()) break;

        const candleEnd = new Date(c.ts.getTime() + intervalMs);

        // wait small grace after boundary
        if (now.getTime() < candleEnd.getTime() + graceMs) break;

        const lastTick = this.lastTickTs.get(key);
        const staleMs =
          lastTick instanceof Date ? now.getTime() - lastTick.getTime() : null;

        // finalize candle
        closed.push({
          ...c,
          closedAt: now,
          finalizedBy: "timer",
          staleMs,
        });

        // create next bucket candle (synthetic placeholder)
        const lastClose = Number(c.close || 0);
        const next = newCandle(
          c.instrument_token,
          intervalMin,
          candleEnd,
          lastClose,
          0,
        );

        // mark synthetic so strategy engine can choose to block if configured
        next.source = "synthetic_timer";
        next.synthetic = true;

        this.current.set(key, next);
        c = next;
        bars++;
      }
    }

    return closed;
  }
}

function newCandle(token, intervalMin, ts, price, volume) {
  return {
    instrument_token: token,
    interval_min: intervalMin,
    ts,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: Number(volume || 0),
    source: "live",
    synthetic: false,
  };
}

module.exports = { CandleBuilder };
