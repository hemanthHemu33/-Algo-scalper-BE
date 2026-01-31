const { DateTime } = require("luxon");
const { env } = require("../config");
const { logger } = require("../logger");
const { getDb } = require("../db");
const {
  enabled: optimizerStateEnabled,
  readState: readOptimizerState,
  writeState: writeOptimizerState,
} = require("./optimizerStateStore");

// Trades collection name is defined in tradeStore.js, but we keep a local constant here to avoid circular deps.
const TRADES_COLLECTION = "trades";

function tz() {
  return env.CANDLE_TZ || "Asia/Kolkata";
}

function n(x, d = NaN) {
  if (x === null || x === undefined || x === "") return d;
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function safeKey(s, maxLen = 64) {
  const v = String(s || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!v) return "UNKNOWN";
  return v.length > maxLen ? v.slice(0, maxLen) : v;
}

function scopeSet() {
  const s = String(env.OPT_BLOCK_SCOPE || "BOTH").toUpperCase();
  if (s === "KEY") return { key: true, strategy: false };
  if (s === "STRATEGY") return { key: false, strategy: true };
  return { key: true, strategy: true };
}

function hhmmToMinutes(hhmm) {
  const t = String(hhmm || "").trim();
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

function minutesOfDay(nowTs) {
  try {
    const dt = DateTime.fromMillis(nowTs, { zone: tz() });
    return dt.hour * 60 + dt.minute;
  } catch {
    const d = new Date(nowTs);
    return d.getHours() * 60 + d.getMinutes();
  }
}

class RollingWindow {
  constructor(max = 60) {
    this.max = Math.max(1, Number(max) || 60);
    this.items = [];
  }

  push(v) {
    if (v === null || v === undefined) return;
    const x = Number(v);
    if (!Number.isFinite(x)) return;
    this.items.push(x);
    if (this.items.length > this.max) {
      this.items.splice(0, this.items.length - this.max);
    }
  }

  get n() {
    return this.items.length;
  }

  avg() {
    if (!this.items.length) return null;
    let s = 0;
    for (const x of this.items) s += x;
    return s / this.items.length;
  }

  snapshot() {
    const a = this.avg();
    return {
      n: this.n,
      avg: Number.isFinite(a) ? a : null,
      last: this.items.length ? this.items[this.items.length - 1] : null,
    };
  }
}

class AdaptiveOptimizer {
  constructor() {
    this._enabled = String(env.OPTIMIZER_ENABLED || "true") === "true";

    // Rolling stats
    this._lookbackN = Number(env.OPT_LOOKBACK_N || 60);

    // Min samples before a key can be auto-blocked
    this._minSamplesKey = Number(
      env.OPT_MIN_SAMPLES_KEY || env.OPT_MIN_SAMPLES || 20,
    );
    this._minSamplesStrategy = Number(
      env.OPT_MIN_SAMPLES_STRATEGY || env.OPT_MIN_SAMPLES || 20,
    );

    // Threshold: avg feeMultiple must be >= this to stay eligible
    this._feeMultipleMin = Number(env.OPT_BLOCK_FEE_MULTIPLE_AVG_MIN || 3);

    // Block duration (minutes)
    this._blockTtlMin = Number(env.OPT_BLOCK_TTL_MIN || 120);

    // De-weighting (soft control)
    this._deweightEnabled =
      String(env.OPT_DEWEIGHT_ENABLED || "true") === "true";
    this._deMinSamples = Number(env.OPT_DEWEIGHT_MIN_SAMPLES || 5);
    this._deConfMin = Number(env.OPT_DEWEIGHT_CONF_MIN || 0.5);
    this._deQtyMin = Number(env.OPT_DEWEIGHT_QTY_MIN || 0.5);

    // Spread-aware penalties (entry spreads are already filtered elsewhere if enabled)
    this._spreadPenaltyBps = Number(env.OPT_SPREAD_PENALTY_BPS || 25);
    this._spreadBlockBps = Number(env.OPT_SPREAD_BLOCK_BPS || 60);
    this._spreadPenaltyConfMult = Number(
      env.OPT_SPREAD_PENALTY_CONF_MULT || 0.9,
    );
    this._spreadBlockEnabled =
      String(env.OPT_SPREAD_BLOCK_ENABLED || "false") === "true";

    // RR floors
    this._rrTrendMin = Number(env.RR_TREND_MIN || 1.5);
    this._rrWideSpreadMin = Number(env.RR_WIDE_SPREAD_MIN || 1.8);

    // Buckets
    this._bucketOpenEnd = String(env.OPT_BUCKET_OPEN_END || "10:00");
    this._bucketCloseStart = String(env.OPT_BUCKET_CLOSE_START || "15:00");

    this._logDecisions = String(env.OPT_LOG_DECISIONS || "true") === "true";

    // Persistent optimizer state (pro: fast restart, stable self-pruning)
    this._persistEnabled = optimizerStateEnabled();
    this._stateFlushSec = Number(env.OPT_STATE_FLUSH_SEC || 15);
    this._stateMaxKeys = Number(env.OPT_STATE_MAX_KEYS || 1500);
    this._stateDirty = false;
    this._stateTimer = null;
    this._stateLoaded = false;
    this._stateLastSavedAt = null;
    this._skipStateLoadOnce = false;

    // state
    this._windows = new Map(); // key -> RollingWindow
    this._blocked = new Map(); // key -> { untilTs, reason, setAtTs, snapshot }

    this._bootstrapped = false;
    this._bootstrapInFlight = null;
  }

  _scope() {
    return scopeSet();
  }

  _log(payload, msg) {
    if (!this._logDecisions) return;
    try {
      logger.info(payload || {}, msg);
    } catch {}
  }

  _markStateDirty() {
    if (!this._persistEnabled) return;
    this._stateDirty = true;
  }

  _startStateTimer() {
    if (!this._persistEnabled) return;
    if (this._stateTimer) return;

    const sec = Number(this._stateFlushSec || 0);
    if (!(sec > 0)) return;

    this._stateTimer = setInterval(() => {
      this.flushState().catch(() => {});
    }, sec * 1000);
    this._stateTimer.unref?.();
  }

  _stopStateTimer() {
    if (this._stateTimer) clearInterval(this._stateTimer);
    this._stateTimer = null;
  }

  _serializeState() {
    const windows = {};
    const blocked = {};

    // Persist only a bounded number of keys to keep doc size safe.
    let wCount = 0;
    for (const [k, w] of this._windows.entries()) {
      if (wCount >= this._stateMaxKeys) break;
      // Compact: store only the numeric items array.
      windows[k] = Array.isArray(w.items)
        ? w.items.slice(-this._lookbackN)
        : [];
      wCount += 1;
    }

    const nowTs = Date.now();
    for (const [k, b] of this._blocked.entries()) {
      if (Number.isFinite(b.untilTs) && nowTs >= b.untilTs) continue;
      blocked[k] = {
        untilTs: b.untilTs,
        setAtTs: b.setAtTs,
        reason: b.reason,
        snapshot: b.snapshot || null,
      };
    }

    return {
      version: 1,
      tz: tz(),
      lookbackN: this._lookbackN,
      feeMultipleMin: this._feeMultipleMin,
      minSamplesKey: this._minSamplesKey,
      minSamplesStrategy: this._minSamplesStrategy,
      blockTtlMin: this._blockTtlMin,
      windows,
      blocked,
      savedAt: new Date(),
    };
  }

  _hydrateState(doc) {
    if (!doc || typeof doc !== "object") return { ok: false, reason: "no_doc" };

    // Respect current config lookbackN; hydrate items into RollingWindow.
    const windows =
      doc.windows && typeof doc.windows === "object" ? doc.windows : {};
    const blocked =
      doc.blocked && typeof doc.blocked === "object" ? doc.blocked : {};

    this._windows.clear();
    this._blocked.clear();

    let countW = 0;
    for (const k of Object.keys(windows)) {
      if (countW >= this._stateMaxKeys) break;
      const arr = windows[k];
      const w = new RollingWindow(this._lookbackN);
      if (Array.isArray(arr)) {
        for (const x of arr) w.push(x);
      }
      this._windows.set(k, w);
      countW += 1;
    }

    const nowTs = Date.now();
    let countB = 0;
    for (const k of Object.keys(blocked)) {
      const b = blocked[k];
      if (!b) continue;
      if (Number.isFinite(b.untilTs) && nowTs >= b.untilTs) continue;
      this._blocked.set(k, {
        untilTs: b.untilTs,
        setAtTs: b.setAtTs,
        reason: String(b.reason || "BLOCKED"),
        snapshot: b.snapshot || null,
      });
      countB += 1;
      if (countB > this._stateMaxKeys) break;
    }

    return { ok: true, windows: countW, blocked: countB };
  }

  async loadPersistedState() {
    if (!this._persistEnabled) return { ok: false, reason: "disabled" };
    const doc = await readOptimizerState();
    if (!doc) return { ok: false, reason: "no_state" };
    const out = this._hydrateState(doc);
    if (out.ok) {
      this._stateLoaded = true;
      this._stateLastSavedAt = doc.updatedAt || doc.savedAt || null;
    }
    return out;
  }

  async flushState(opts = {}) {
    const force = !!opts.force;
    if (!this._persistEnabled) return { ok: false, reason: "disabled" };
    if (!force && !this._stateDirty) return { ok: true, skipped: true };

    const doc = this._serializeState();
    const out = await writeOptimizerState(doc);
    if (out.ok) {
      this._stateDirty = false;
      this._stateLastSavedAt = doc.savedAt;
    }
    return out;
  }

  _bucket(nowTs) {
    const openEnd = hhmmToMinutes(this._bucketOpenEnd);
    const closeStart = hhmmToMinutes(this._bucketCloseStart);
    const m = minutesOfDay(nowTs);
    if (openEnd != null && m < openEnd) return "OPEN";
    if (closeStart != null && m >= closeStart) return "CLOSE";
    return "MID";
  }

  _keyKey({ symbol, strategyId, bucket }) {
    const sym = safeKey(symbol, 64).toUpperCase();
    const sid = safeKey(strategyId, 64);
    const b = safeKey(bucket, 16);
    return `K|${sym}|${sid}|${b}`;
  }

  _strategyKey({ strategyId, bucket }) {
    const sid = safeKey(strategyId, 64);
    const b = safeKey(bucket, 16);
    return `S|${sid}|${b}`;
  }

  _getWindow(key) {
    const k = String(key || "");
    let w = this._windows.get(k);
    if (!w) {
      w = new RollingWindow(this._lookbackN);
      this._windows.set(k, w);
    }
    return w;
  }

  _getBlocked(key, nowTs) {
    const k = String(key || "");
    const b = this._blocked.get(k);
    if (!b) return null;
    if (Number.isFinite(b.untilTs) && nowTs >= b.untilTs) {
      this._blocked.delete(k);
      this._markStateDirty();
      return null;
    }
    return b;
  }

  _setBlocked(key, nowTs, reason, snapshot) {
    const k = String(key || "");
    const untilTs = nowTs + Math.max(1, this._blockTtlMin) * 60 * 1000;
    this._blocked.set(k, {
      untilTs,
      setAtTs: nowTs,
      reason: String(reason || "BLOCKED"),
      snapshot: snapshot || null,
    });
    this._markStateDirty();
  }

  _volRegime({ atrBase, close }) {
    const atr = n(atrBase, NaN);
    const c = n(close, NaN);
    if (!(atr > 0) || !(c > 0)) {
      return { regime: "UNKNOWN", atrPct: null };
    }
    const atrPct = (atr / c) * 100;
    const low = n(env.VOL_LOW_PCT, 0.8);
    const high = n(env.VOL_HIGH_PCT, 2.0);
    if (atrPct < low) return { regime: "LOW", atrPct };
    if (atrPct > high) return { regime: "HIGH", atrPct };
    return { regime: "MED", atrPct };
  }

  _rrFromVolRegime(volRegime, rrBase) {
    const base = n(rrBase, 1.0);
    if (volRegime === "LOW") return Math.max(base, n(env.RR_VOL_LOW, base));
    if (volRegime === "HIGH") return Math.max(base, n(env.RR_VOL_HIGH, base));
    if (volRegime === "MED") return Math.max(base, n(env.RR_VOL_MED, base));
    return base;
  }

  _spreadRegime(spreadBps) {
    const bps = n(spreadBps, NaN);
    if (!Number.isFinite(bps) || bps <= 0)
      return { regime: "UNKNOWN", bps: null };
    if (bps >= this._spreadBlockBps) return { regime: "EXTREME", bps };
    if (bps >= this._spreadPenaltyBps) return { regime: "WIDE", bps };
    return { regime: "OK", bps };
  }

  evaluateSignal({
    symbol,
    strategyId,
    nowTs,
    atrBase,
    close,
    rrBase,
    spreadBps,
    signalRegime,
    strategyStyle,
    confidence,
  }) {
    if (!this._enabled)
      return { ok: true, meta: { note: "optimizer_disabled" } };

    const ts = Number(nowTs) || Date.now();
    const bucket = this._bucket(ts);

    const keyKey = this._keyKey({ symbol, strategyId, bucket });
    const stratKey = this._strategyKey({ strategyId, bucket });

    // Hard blocks
    const scope = this._scope();
    const bKey = scope.key ? this._getBlocked(keyKey, ts) : null;
    if (bKey) {
      const meta = {
        key: keyKey,
        bucket,
        scope: "KEY",
        blockedUntilTs: bKey.untilTs,
        snapshot: bKey.snapshot,
      };
      this._log({ ...meta, reason: bKey.reason }, "[optimizer] blocked key");
      return { ok: false, reason: `OPT_BLOCK_KEY: ${bKey.reason}`, meta };
    }

    const bStrat = scope.strategy ? this._getBlocked(stratKey, ts) : null;
    if (bStrat) {
      const meta = {
        key: stratKey,
        bucket,
        scope: "STRATEGY",
        blockedUntilTs: bStrat.untilTs,
        snapshot: bStrat.snapshot,
      };
      this._log(
        { ...meta, reason: bStrat.reason },
        "[optimizer] blocked strategy",
      );
      return {
        ok: false,
        reason: `OPT_BLOCK_STRATEGY: ${bStrat.reason}`,
        meta,
      };
    }

    // Spread regime & optional hard-block
    const sp = this._spreadRegime(spreadBps);
    if (this._spreadBlockEnabled && sp.regime === "EXTREME") {
      const meta = {
        key: keyKey,
        bucket,
        spreadBps: sp.bps,
        spreadRegime: sp.regime,
      };
      this._log(meta, "[optimizer] blocked extreme spread");
      return {
        ok: false,
        reason: `OPT_BLOCK_SPREAD (${sp.bps.toFixed(1)}bps)`,
        meta,
      };
    }

    // RR tuning: volatility + trend/spread floors
    const vr = this._volRegime({ atrBase, close });
    let rrUsed = this._rrFromVolRegime(vr.regime, rrBase);

    const signalReg = String(signalRegime || "").toUpperCase();
    const style = String(strategyStyle || "").toUpperCase();
    if (signalReg === "TREND" || style === "TREND") {
      rrUsed = Math.max(rrUsed, this._rrTrendMin);
    }
    if (sp.regime === "WIDE") {
      rrUsed = Math.max(rrUsed, this._rrWideSpreadMin);
    }

    // Soft de-weighting (confidence + optional qty)
    let confidenceMult = 1;
    let qtyMult = 1;

    if (this._deweightEnabled) {
      const wKey = this._windows.get(keyKey);
      const wStrat = this._windows.get(stratKey);

      const aKey = wKey ? wKey.avg() : null;
      const nKey = wKey ? wKey.n : 0;
      const aStr = wStrat ? wStrat.avg() : null;
      const nStr = wStrat ? wStrat.n : 0;

      const thr = this._feeMultipleMin;

      let ratioKey = 1;
      if (Number.isFinite(aKey) && nKey >= this._deMinSamples && thr > 0) {
        ratioKey = aKey / thr;
      }

      let ratioStr = 1;
      if (Number.isFinite(aStr) && nStr >= this._deMinSamples && thr > 0) {
        ratioStr = aStr / thr;
      }

      const ratio = Math.min(ratioKey, ratioStr);

      confidenceMult = clamp(ratio, this._deConfMin, 1);
      qtyMult = clamp(ratio, this._deQtyMin, 1);

      // Additional spread penalty
      if (sp.regime === "WIDE") {
        confidenceMult *= this._spreadPenaltyConfMult;
        confidenceMult = clamp(confidenceMult, this._deConfMin, 1);
      }
    }

    const meta = {
      keyKey,
      stratKey,
      bucket,
      rrUsed,
      rrBase: n(rrBase, 1.0),
      volRegime: vr.regime,
      atrPct: vr.atrPct,
      spreadRegime: sp.regime,
      spreadBps: sp.bps,
      confidence: Number.isFinite(Number(confidence))
        ? Number(confidence)
        : null,
      confidenceMult,
      qtyMult,
    };

    if (confidenceMult < 1 || qtyMult < 1) {
      this._log(meta, "[optimizer] deweight applied");
    }

    return { ok: true, meta };
  }

  recordTradeClose({ symbol, strategyId, feeMultiple, startedAtTs, nowTs }) {
    if (!this._enabled) return { ok: false, reason: "optimizer_disabled" };

    const fm = Number(feeMultiple);
    if (!Number.isFinite(fm)) return { ok: false, reason: "no_feeMultiple" };

    const started = Number(startedAtTs) || Number(nowTs) || Date.now();
    const ts = Number(nowTs) || Date.now();
    const bucket = this._bucket(started);

    const keyKey = this._keyKey({ symbol, strategyId, bucket });
    const stratKey = this._strategyKey({ strategyId, bucket });

    // Update rolling windows
    const wKey = this._getWindow(keyKey);
    const wStr = this._getWindow(stratKey);

    wKey.push(fm);
    wStr.push(fm);
    this._markStateDirty();

    const snapKey = wKey.snapshot();
    const snapStr = wStr.snapshot();

    const thr = this._feeMultipleMin;
    const scope = this._scope();

    // Auto-block weak keys
    if (
      scope.key &&
      snapKey.n >= this._minSamplesKey &&
      Number.isFinite(snapKey.avg) &&
      thr > 0
    ) {
      if (snapKey.avg < thr) {
        this._setBlocked(
          keyKey,
          ts,
          `avgFeeMultiple ${snapKey.avg.toFixed(2)} < ${thr}`,
          {
            ...snapKey,
            symbol: safeKey(symbol, 64),
            strategyId: safeKey(strategyId, 64),
            bucket,
          },
        );
        this._log({ keyKey, bucket, ...snapKey }, "[optimizer] auto-block key");
      } else {
        // If it recovered, unblock early
        const b = this._blocked.get(keyKey);
        if (b) {
          this._blocked.delete(keyKey);
          this._markStateDirty();
        }
      }
    }

    if (
      scope.strategy &&
      snapStr.n >= this._minSamplesStrategy &&
      Number.isFinite(snapStr.avg) &&
      thr > 0
    ) {
      if (snapStr.avg < thr) {
        this._setBlocked(
          stratKey,
          ts,
          `avgFeeMultiple ${snapStr.avg.toFixed(2)} < ${thr}`,
          {
            ...snapStr,
            strategyId: safeKey(strategyId, 64),
            bucket,
          },
        );
        this._log(
          { stratKey, bucket, ...snapStr },
          "[optimizer] auto-block strategy",
        );
      } else {
        const b = this._blocked.get(stratKey);
        if (b) {
          this._blocked.delete(stratKey);
          this._markStateDirty();
        }
      }
    }

    return {
      ok: true,
      keyKey,
      stratKey,
      bucket,
      key: snapKey,
      strategy: snapStr,
    };
  }

  snapshot() {
    const windows = {};
    const blocked = {};

    for (const [k, w] of this._windows.entries()) {
      // Avoid huge snapshots
      if (Object.keys(windows).length > 200) break;
      windows[k] = w.snapshot();
    }

    for (const [k, b] of this._blocked.entries()) {
      blocked[k] = {
        untilTs: b.untilTs,
        setAtTs: b.setAtTs,
        reason: b.reason,
        snapshot: b.snapshot || null,
      };
    }

    return {
      enabled: this._enabled,
      persist: {
        enabled: this._persistEnabled,
        loaded: this._stateLoaded,
        dirty: this._stateDirty,
        lastSavedAt: this._stateLastSavedAt,
      },
      lookbackN: this._lookbackN,
      feeMultipleMin: this._feeMultipleMin,
      minSamplesKey: this._minSamplesKey,
      minSamplesStrategy: this._minSamplesStrategy,
      blockTtlMin: this._blockTtlMin,
      deweightEnabled: this._deweightEnabled,
      deweightMinSamples: this._deMinSamples,
      rrTrendMin: this._rrTrendMin,
      rrWideSpreadMin: this._rrWideSpreadMin,
      spreadPenaltyBps: this._spreadPenaltyBps,
      spreadBlockBps: this._spreadBlockBps,
      spreadBlockEnabled: this._spreadBlockEnabled,
      buckets: {
        openEnd: this._bucketOpenEnd,
        closeStart: this._bucketCloseStart,
      },
      windows,
      blocked,
    };
  }

  reset() {
    this._windows.clear();
    this._blocked.clear();
    this._stateLoaded = false;
    this._markStateDirty();
    this._bootstrapped = false;
    this._bootstrapInFlight = null;
  }

  async start() {
    if (!this._enabled) return { ok: false, reason: "disabled" };

    // Begin periodic persistence (no-op if disabled)
    this._startStateTimer();

    // Try loading persisted optimizer state once per process.
    let loadedFromState = false;
    const skipPersistLoad = !!this._skipStateLoadOnce;
    this._skipStateLoadOnce = false;
    if (this._persistEnabled && !this._stateLoaded && !skipPersistLoad) {
      try {
        const r = await this.loadPersistedState();
        loadedFromState = !!(r && r.ok && r.windows > 0);
        if (loadedFromState) {
          logger.info(r, "[optimizer] loaded persisted state");
        }
      } catch {}
    }

    const wantBootstrap =
      String(env.OPTIMIZER_BOOTSTRAP_FROM_DB || "true") === "true";
    if (!wantBootstrap) {
      this._bootstrapped = true;
      return { ok: true, bootstrapped: false, loadedFromState };
    }

    if (this._bootstrapped) return { ok: true, bootstrapped: true };

    // If state was loaded, treat as bootstrapped (skip DB scan)
    if (loadedFromState) {
      this._bootstrapped = true;
      return { ok: true, bootstrapped: true, loadedFromState };
    }

    if (this._bootstrapInFlight) return this._bootstrapInFlight;

    this._bootstrapInFlight = this._bootstrapFromDb()
      .then((r) => {
        this._bootstrapped = true;
        this._bootstrapInFlight = null;
        return r;
      })
      .catch((e) => {
        this._bootstrapInFlight = null;
        logger.warn(
          { e: e?.message },
          "[optimizer] bootstrap failed; continuing without",
        );
        return { ok: false, reason: "bootstrap_failed" };
      });

    return this._bootstrapInFlight;
  }

  async reloadFromDb() {
    // Force a DB re-bootstrap even if persistence is enabled.
    this._skipStateLoadOnce = true;
    this.reset();
    return this.start();
  }

  async _bootstrapFromDb() {
    let db;
    try {
      db = getDb();
    } catch {
      return { ok: false, reason: "db_not_ready" };
    }

    const days = Number(env.OPT_BOOTSTRAP_DAYS || 7);
    const since = DateTime.now()
      .setZone(tz())
      .minus({ days: Math.max(1, days) })
      .toJSDate();

    const col = db.collection(TRADES_COLLECTION);

    const cursor = col
      .find(
        {
          createdAt: { $gte: since },
          feeMultiple: { $ne: null },
          strategyId: { $ne: null },
        },
        {
          projection: {
            createdAt: 1,
            closedAt: 1,
            updatedAt: 1,
            feeMultiple: 1,
            strategyId: 1,
            instrument: 1,
          },
        },
      )
      .sort({ createdAt: -1 })
      .limit(Math.max(100, this._lookbackN * 40));

    let count = 0;
    while (await cursor.hasNext()) {
      const t = await cursor.next();
      const sym =
        t?.instrument?.tradingsymbol ||
        t?.instrument?.symbol ||
        t?.instrument?.name ||
        "UNKNOWN";

      const startedAt = t?.createdAt
        ? new Date(t.createdAt).getTime()
        : Date.now();
      const closedAt = t?.closedAt
        ? new Date(t.closedAt).getTime()
        : t?.updatedAt
          ? new Date(t.updatedAt).getTime()
          : Date.now();

      this.recordTradeClose({
        symbol: sym,
        strategyId: t?.strategyId || "UNKNOWN",
        feeMultiple: t?.feeMultiple,
        startedAtTs: startedAt,
        nowTs: closedAt,
      });

      count += 1;
      if (count > this._lookbackN * 40) break;
    }

    logger.info({ count, days }, "[optimizer] bootstrapped from DB");
    return { ok: true, count, days };
  }
}

const optimizer = new AdaptiveOptimizer();

module.exports = { optimizer };
