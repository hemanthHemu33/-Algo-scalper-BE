const { env } = require("../config");
const { logger } = require("../logger");
const { reportFault } = require("../runtime/errorBus");
const {
  enabled: storeEnabled,
  readAllCalibration,
  upsertCalibration,
  insertReconciliationRun,
  listReconciliations,
} = require("./costCalibratorStore");

function up(s) {
  return String(s || "").trim().toUpperCase();
}

function n(x, d = NaN) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

class CostCalibrator {
  constructor() {
    this._ready = false;
    this._map = new Map(); // segmentKey -> { multiplier, updatedAt }
  }

  get enabled() {
    return storeEnabled();
  }

  async start() {
    if (!this.enabled) {
      this._ready = true;
      return { ok: true, enabled: false };
    }

    try {
      const rows = await readAllCalibration();
      this._map.clear();
      for (const r of rows || []) {
        const sk = up(r.segmentKey);
        const m = n(r.multiplier, NaN);
        if (!sk || !Number.isFinite(m) || m <= 0) continue;
        this._map.set(sk, {
          multiplier: m,
          updatedAt: r.updatedAt || r.createdAt || null,
          meta: r.meta || null,
        });
      }
      this._ready = true;
      logger.info(
        { count: this._map.size },
        "[costCalibrator] bootstrapped from DB",
      );
      return { ok: true, enabled: true, count: this._map.size };
    } catch (e) {
      logger.warn({ err: e?.message || String(e) }, "[costCalibrator] start failed");
      this._ready = true;
      return { ok: false, enabled: true, error: e?.message || String(e) };
    }
  }

  snapshot() {
    const out = {};
    for (const [k, v] of this._map.entries()) {
      out[k] = { multiplier: v.multiplier, updatedAt: v.updatedAt || null };
    }
    return {
      enabled: this.enabled,
      ready: this._ready,
      count: this._map.size,
      multipliers: out,
      alpha: n(env.COST_CALIBRATION_ALPHA, 0.25),
      clamp: {
        min: n(env.COST_CALIBRATION_MULT_MIN, 0.6),
        max: n(env.COST_CALIBRATION_MULT_MAX, 2.5),
      },
    };
  }

  getMultiplier(segmentKey) {
    if (!this.enabled) return 1;
    const sk = up(segmentKey);
    const v = this._map.get(sk);
    const m = n(v?.multiplier, 1);
    return Number.isFinite(m) && m > 0 ? m : 1;
  }

  async reloadFromDb() {
    this._ready = false;
    return this.start();
  }

  async updateFromRatios({ ratiosBySegment, runMeta }) {
    if (!this.enabled) {
      return { ok: true, enabled: false, updated: 0 };
    }

    const alpha = clamp(n(env.COST_CALIBRATION_ALPHA, 0.25), 0.01, 0.8);
    const lo = clamp(n(env.COST_CALIBRATION_MULT_MIN, 0.6), 0.05, 10);
    const hi = clamp(n(env.COST_CALIBRATION_MULT_MAX, 2.5), lo, 20);

    const updates = [];
    for (const [seg, ratioRaw] of Object.entries(ratiosBySegment || {})) {
      const sk = up(seg);
      const ratio = n(ratioRaw, NaN);
      if (!sk || !Number.isFinite(ratio) || ratio <= 0) continue;

      const prev = this.getMultiplier(sk);
      // EMA on the *ratio* (actual/baseEstimate) becomes new multiplier.
      const next = clamp(prev * (1 - alpha) + ratio * alpha, lo, hi);
      updates.push({ segmentKey: sk, prev, ratio, next });
    }

    // Persist updates
    let updated = 0;
    for (const u of updates) {
      await upsertCalibration({
        segmentKey: u.segmentKey,
        multiplier: u.next,
        meta: {
          prev: u.prev,
          ratio: u.ratio,
          alpha,
          source: "contract_note_reconciler",
          runMeta: runMeta || null,
        },
      });
      this._map.set(u.segmentKey, {
        multiplier: u.next,
        updatedAt: new Date(),
        meta: { prev: u.prev, ratio: u.ratio, alpha },
      });
      updated += 1;
    }

    // Store a reconciliation run doc (for audit)
    try {
      if (runMeta) {
        await insertReconciliationRun({
          ok: true,
          source: "contract_note_reconciler",
          updated,
          ratiosBySegment: ratiosBySegment || {},
          updates,
          alpha,
          clamp: { lo, hi },
          runMeta,
        });
      }
    } catch (err) { reportFault({ code: "TRADING_COSTCALIBRATOR_CATCH", err, message: "[src/trading/costCalibrator.js] caught and continued" }); }

    return { ok: true, enabled: true, updated, updates };
  }

  async recentRuns(limit = 10) {
    try {
      return await listReconciliations(limit);
    } catch {
      return [];
    }
  }
}

const costCalibrator = new CostCalibrator();

module.exports = { costCalibrator };
