const { env } = require("../config");

class MarketHealth {
  constructor() {
    this.lastTickByToken = new Map();
    this.gapsByToken = new Map();
    this.totalTicks = 0;
    this.totalGaps = 0;
    this.missingTimestamp = 0;
  }

  onTicks(ticks) {
    const expectedGapMs = Number(env.MARKET_HEALTH_GAP_MS ?? 2000);
    const now = Date.now();

    for (const t of ticks || []) {
      const token = Number(t?.instrument_token ?? t?.instrumentToken);
      if (!Number.isFinite(token) || token <= 0) continue;

      this.totalTicks += 1;

      const tsRaw = t?.exchange_timestamp || t?.last_trade_time || now;
      if (!t?.exchange_timestamp && !t?.last_trade_time) {
        this.missingTimestamp += 1;
      }
      const tickTs = new Date(tsRaw).getTime();
      const last = this.lastTickByToken.get(token) || null;

      if (last && Number.isFinite(last)) {
        const gap = tickTs - last;
        if (Number.isFinite(gap) && gap > expectedGapMs) {
          const cur = this.gapsByToken.get(token) || 0;
          this.gapsByToken.set(token, cur + 1);
          this.totalGaps += 1;
        }
      }

      this.lastTickByToken.set(token, tickTs);
    }
  }

  snapshot({ tokens } = {}) {
    const now = Date.now();
    const out = [];
    const pick = Array.isArray(tokens) && tokens.length ? tokens : null;

    const entries = pick
      ? pick.map((t) => [Number(t), this.lastTickByToken.get(Number(t))])
      : Array.from(this.lastTickByToken.entries());

    for (const [token, lastTs] of entries) {
      if (!token || !lastTs) continue;
      const lagMs = now - lastTs;
      out.push({
        instrument_token: Number(token),
        lastTickAt: new Date(lastTs).toISOString(),
        lagMs: Number.isFinite(lagMs) ? lagMs : null,
        gaps: this.gapsByToken.get(Number(token)) || 0,
      });
    }

    return {
      now: new Date().toISOString(),
      totals: {
        ticks: this.totalTicks,
        gaps: this.totalGaps,
        missingTimestamp: this.missingTimestamp,
      },
      byToken: out.sort((a, b) => b.lagMs - a.lagMs),
    };
  }
}

const marketHealth = new MarketHealth();

module.exports = { MarketHealth, marketHealth };
