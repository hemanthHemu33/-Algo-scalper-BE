const { env } = require("../config");
const { logger } = require("../logger");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
}

function clampNum(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function jitterMs(ms, pct) {
  const base = Math.max(0, Number(ms) || 0);
  const p = clampNum(pct, 0, 1);
  const span = base * p;
  const j = (Math.random() * 2 - 1) * span; // +/-
  return Math.max(0, Math.round(base + j));
}

function nowMs() {
  return Date.now();
}

function getHttpStatus(e) {
  // KiteConnect errors can vary. Be defensive.
  const s =
    e?.status_code ??
    e?.status ??
    e?.response?.status ??
    e?.response?.statusCode ??
    e?.http_status ??
    null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function isRetryable(e) {
  const status = getHttpStatus(e);
  const msg = String(e?.message || e || "").toLowerCase();

  if (status === 429) return true;
  if (status && status >= 500 && status <= 599) return true;

  if (msg.includes("429") || msg.includes("too many")) return true;
  if (msg.includes("timeout") || msg.includes("etimedout")) return true;
  if (msg.includes("econnreset") || msg.includes("socket hang up")) return true;

  return false;
}

function chunk(arr, size) {
  const out = [];
  const n = Math.max(1, Number(size) || 1);
  for (let i = 0; i < (arr || []).length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function readCfg() {
  return {
    enabled: String(env.QUOTE_GUARD_ENABLED || "true") !== "false",
    chunkSize: clampNum(env.QUOTE_GUARD_CHUNK_SIZE || 75, 10, 200),
    maxInFlight: clampNum(env.QUOTE_GUARD_MAX_INFLIGHT || 1, 1, 4),
    minIntervalMs: clampNum(env.QUOTE_GUARD_MIN_INTERVAL_MS || 150, 0, 5000),
    budgetWindowMs: clampNum(
      env.QUOTE_GUARD_BUDGET_WINDOW_MS || 10000,
      1000,
      60000,
    ),
    budgetMax: clampNum(env.QUOTE_GUARD_BUDGET_MAX || 20, 0, 500),
    maxRetries: clampNum(env.QUOTE_GUARD_MAX_RETRIES || 3, 0, 8),
    backoffBaseMs: clampNum(env.QUOTE_GUARD_BACKOFF_BASE_MS || 250, 50, 5000),
    backoffMaxMs: clampNum(env.QUOTE_GUARD_BACKOFF_MAX_MS || 5000, 100, 30000),
    jitterPct: clampNum(env.QUOTE_GUARD_JITTER_PCT || 0.25, 0, 1),
    breakerFails: clampNum(env.QUOTE_GUARD_BREAKER_FAILS || 4, 1, 20),
    breakerCooldownMs: clampNum(
      env.QUOTE_GUARD_BREAKER_COOLDOWN_MS || 20000,
      1000,
      300000,
    ),
  };
}

const state = {
  draining: false,
  inFlight: 0,
  queue: [],
  lastReqAt: 0,
  recentReqTs: [],
  failStreak: 0,
  breakerOpenUntil: 0,
  stats: {
    enqueued: 0,
    dequeued: 0,
    requests: 0,
    chunks: 0,
    retries: 0,
    failures: 0,
    breakerOpens: 0,
    lastError: null,
    lastErrorAt: null,
    lastSuccessAt: null,
  },
};

function pruneRecent(now, windowMs) {
  const w = Number(windowMs) || 0;
  while (state.recentReqTs.length && now - state.recentReqTs[0] > w) {
    state.recentReqTs.shift();
  }
}

async function applyRateLimits(cfg) {
  const t = nowMs();

  if (state.breakerOpenUntil && t < state.breakerOpenUntil) {
    const e = new Error("QUOTE_GUARD_BREAKER_OPEN");
    e.code = "QUOTE_GUARD_BREAKER_OPEN";
    throw e;
  }

  let waitMs = 0;

  // Minimum spacing between requests
  if (cfg.minIntervalMs > 0) {
    waitMs = Math.max(waitMs, cfg.minIntervalMs - (t - (state.lastReqAt || 0)));
  }

  // Simple request budget: max requests in window
  if (cfg.budgetMax > 0 && cfg.budgetWindowMs > 0) {
    pruneRecent(t, cfg.budgetWindowMs);
    if (state.recentReqTs.length >= cfg.budgetMax) {
      const oldest = state.recentReqTs[0] || t;
      const until = oldest + cfg.budgetWindowMs;
      waitMs = Math.max(waitMs, until - t);
    }
  }

  if (waitMs > 0) await sleep(jitterMs(waitMs, cfg.jitterPct));
}

function openBreaker(cfg, err) {
  const t = nowMs();
  state.breakerOpenUntil = t + (cfg.breakerCooldownMs || 20000);
  state.stats.breakerOpens += 1;
  state.stats.lastError = err?.message || String(err);
  state.stats.lastErrorAt = new Date(t).toISOString();
  logger.warn(
    {
      until: new Date(state.breakerOpenUntil).toISOString(),
      failStreak: state.failStreak,
      err: state.stats.lastError,
    },
    "[quote-guard] breaker opened",
  );
}

async function guardedGetQuoteOnce(kite, keys, meta) {
  const cfg = readCfg();
  await applyRateLimits(cfg);

  const t = nowMs();
  state.lastReqAt = t;
  state.recentReqTs.push(t);
  state.stats.requests += 1;

  // NOTE: Kite expects array of "EXCHANGE:TRADINGSYMBOL" keys
  return kite.getQuote(keys);
}

async function guardedGetQuoteWithRetry(kite, keys, meta) {
  const cfg = readCfg();

  let attempt = 0;
  // First attempt + retries
  while (true) {
    try {
      const res = await guardedGetQuoteOnce(kite, keys, meta);
      state.failStreak = 0;
      state.stats.lastSuccessAt = new Date().toISOString();
      return res || {};
    } catch (e) {
      const retryable = isRetryable(e);
      state.stats.failures += 1;
      state.stats.lastError = e?.message || String(e);
      state.stats.lastErrorAt = new Date().toISOString();

      if (!retryable || attempt >= cfg.maxRetries) {
        state.failStreak += 1;
        if (state.failStreak >= cfg.breakerFails) {
          openBreaker(cfg, e);
        }

        logger.warn(
          {
            label: meta?.label,
            size: (keys || []).length,
            attempt,
            retryable,
            status: getHttpStatus(e),
            err: e?.message || String(e),
          },
          "[quote-guard] getQuote failed",
        );
        throw e;
      }

      // Retry
      attempt += 1;
      state.stats.retries += 1;

      const backoff = Math.min(
        cfg.backoffMaxMs,
        cfg.backoffBaseMs * Math.pow(2, Math.max(0, attempt - 1)),
      );
      await sleep(jitterMs(backoff, cfg.jitterPct));
    }
  }
}

function enqueue(taskFn, meta) {
  state.stats.enqueued += 1;
  return new Promise((resolve, reject) => {
    state.queue.push({ taskFn, meta, resolve, reject });
    drain();
  });
}

async function drain() {
  if (state.draining) return;
  state.draining = true;

  try {
    while (state.queue.length) {
      const cfg = readCfg();
      // Respect concurrency
      if (state.inFlight >= cfg.maxInFlight) {
        await sleep(5);
        continue;
      }

      const item = state.queue.shift();
      state.stats.dequeued += 1;
      state.inFlight += 1;

      (async () => {
        try {
          const res = await item.taskFn();
          item.resolve(res);
        } catch (e) {
          item.reject(e);
        } finally {
          state.inFlight -= 1;
        }
      })();

      // Small yield so we don't spin tight in event loop
      await sleep(0);
    }
  } finally {
    state.draining = false;
  }
}

async function getQuoteGuarded(kite, keys, meta = {}) {
  const cfg = readCfg();
  const arr = (keys || []).filter(Boolean);
  if (!arr.length) return {};

  if (!cfg.enabled) {
    try {
      return (await kite.getQuote(arr)) || {};
    } catch (e) {
      logger.warn(
        { label: meta?.label, err: e?.message || String(e) },
        "[quote-guard] disabled; getQuote failed",
      );
      return {};
    }
  }

  // If breaker is open, fail fast (return empty) to avoid hammering API.
  const t = nowMs();
  if (state.breakerOpenUntil && t < state.breakerOpenUntil) {
    logger.warn(
      {
        label: meta?.label,
        until: new Date(state.breakerOpenUntil).toISOString(),
      },
      "[quote-guard] breaker open; returning empty quotes",
    );
    return {};
  }

  const chunks = chunk(arr, cfg.chunkSize);
  state.stats.chunks += chunks.length;

  const results = {};
  for (const part of chunks) {
    try {
      const q = await enqueue(
        () => guardedGetQuoteWithRetry(kite, part, meta),
        {
          label: meta?.label,
          size: part.length,
        },
      );
      if (q && typeof q === "object") {
        for (const k of Object.keys(q)) results[k] = q[k];
      }
    } catch (e) {
      // Already logged inside guardedGetQuoteWithRetry.
      // Continue and return partial results.
    }
  }

  return results;
}

function getQuoteGuardStats() {
  return {
    enabled: String(env.QUOTE_GUARD_ENABLED || "true") !== "false",
    inFlight: state.inFlight,
    queue: state.queue.length,
    lastReqAt: state.lastReqAt ? new Date(state.lastReqAt).toISOString() : null,
    breakerOpenUntil: state.breakerOpenUntil
      ? new Date(state.breakerOpenUntil).toISOString()
      : null,
    failStreak: state.failStreak,
    recentReq: state.recentReqTs.length,
    stats: { ...state.stats, failStreak: state.failStreak },
  };
}

function isQuoteGuardBreakerOpen() {
  const t = nowMs();
  return Boolean(state.breakerOpenUntil && t < state.breakerOpenUntil);
}

module.exports = {
  getQuoteGuarded,
  getQuoteGuardStats,
  isQuoteGuardBreakerOpen,
};
