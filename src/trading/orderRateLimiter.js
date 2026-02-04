const { env } = require("../config");

/**
 * Lightweight in-process rate limiter for order placement.
 *
 * Zerodha Kite practical limits (commonly cited):
 * - ~10 orders/second
 * - ~200 orders/minute
 * - daily cap varies by segment/account (set MAX_ORDERS_PER_DAY)
 *
 * This limiter enforces per-second and per-minute. Daily is enforced in TradeManager
 * using daily_risk.ordersPlaced (persisted).
 */
class OrderRateLimiter {
  constructor({ maxPerSec, maxPerMin } = {}) {
    this.secBucketStart = 0;
    this.secCount = 0;

    this.minBucketStart = 0;
    this.minCount = 0;

    this.maxPerSec = Number.isFinite(Number(maxPerSec))
      ? Number(maxPerSec)
      : Number(env.MAX_ORDERS_PER_SEC || 10);
    this.maxPerMin = Number.isFinite(Number(maxPerMin))
      ? Number(maxPerMin)
      : Number(env.MAX_ORDERS_PER_MIN || 200);
  }

  _bucketStartMs(now, sizeMs) {
    return now - (now % sizeMs);
  }

  check({ now = Date.now(), count = 1 } = {}) {
    const perSec = this.maxPerSec;
    const perMin = this.maxPerMin;

    const secStart = this._bucketStartMs(now, 1000);
    if (secStart !== this.secBucketStart) {
      this.secBucketStart = secStart;
      this.secCount = 0;
    }

    const minStart = this._bucketStartMs(now, 60_000);
    if (minStart !== this.minBucketStart) {
      this.minBucketStart = minStart;
      this.minCount = 0;
    }

    if (this.secCount + count > perSec) {
      return { ok: false, reason: "rate_limit_per_sec", limit: perSec };
    }
    if (this.minCount + count > perMin) {
      return { ok: false, reason: "rate_limit_per_min", limit: perMin };
    }
    return { ok: true };
  }

  record({ now = Date.now(), count = 1 } = {}) {
    const secStart = this._bucketStartMs(now, 1000);
    if (secStart !== this.secBucketStart) {
      this.secBucketStart = secStart;
      this.secCount = 0;
    }

    const minStart = this._bucketStartMs(now, 60_000);
    if (minStart !== this.minBucketStart) {
      this.minBucketStart = minStart;
      this.minCount = 0;
    }

    this.secCount += count;
    this.minCount += count;
  }
}

module.exports = { OrderRateLimiter };
