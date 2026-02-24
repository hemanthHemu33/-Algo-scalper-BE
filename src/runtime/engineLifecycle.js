const { DateTime } = require("luxon");
const { env } = require("../config");
const { logger } = require("../logger");
const { notifyLifecycle } = require("./lifecycleNotify");

let _instance = null;

function boolEnv(v, def = false) {
  if (v === undefined || v === null) return def;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return def;
}

function numEnv(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function parseHolidaySet(raw) {
  return new Set(
    String(raw || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
}

function hhmmToDate(dt, hhmm) {
  const [hRaw, mRaw] = String(hhmm || "00:00").split(":");
  const h = Math.max(0, Math.min(23, Number(hRaw) || 0));
  const m = Math.max(0, Math.min(59, Number(mRaw) || 0));
  return dt.set({ hour: h, minute: m, second: 0, millisecond: 0 });
}

function makeLifecycle(ops = {}) {
  const cfg = {
    enabled: boolEnv(env.ENGINE_LIFECYCLE_ENABLED, false),
    tz: String(env.MARKET_TZ || "Asia/Kolkata"),
    warmupHHMM: String(env.ENGINE_WARMUP_HHMM || "09:10"),
    liveHHMM: String(env.ENGINE_LIVE_HHMM || "09:15"),
    closeHHMM: String(env.ENGINE_CLOSE_HHMM || "15:30"),
    idleAfterMin: numEnv(env.ENGINE_IDLE_AFTER_MIN, 5),
    requireFlat: boolEnv(env.ENGINE_REQUIRE_FLAT_BEFORE_IDLE, true),
    forceFlatten: boolEnv(env.ENGINE_FORCE_FLATTEN_AT_CLOSE, false),
    forceFlattenDeadlineMin: numEnv(env.ENGINE_FORCE_FLATTEN_DEADLINE_MIN, 10),
    cooldownPollSec: numEnv(env.ENGINE_COOLDOWN_POLL_SEC, 10),
    idleGuardSec: numEnv(env.ENGINE_IDLE_GUARD_SEC, 60),
    nearGuardSec: numEnv(env.ENGINE_NEAR_EVENT_GUARD_SEC, 5),
    holidays: parseHolidaySet(env.MARKET_HOLIDAYS),
    testNowIso: String(env.ENGINE_TEST_NOW_ISO || "").trim(),
  };

  let state = "IDLE";
  let token = null;
  let nextTransitionAt = null;
  let wakeTimer = null;
  let idleGuardTimer = null;
  let cooldownTimer = null;
  let forceFlattenStartedAt = 0;
  let forceFlattenDeadlineHit = false;

  const nowIst = () => {
    if (cfg.testNowIso) {
      const dt = DateTime.fromISO(cfg.testNowIso, { zone: cfg.tz });
      if (dt.isValid) return dt;
    }
    return DateTime.now().setZone(cfg.tz);
  };

  function clearTimer(ref) {
    if (ref) clearTimeout(ref);
    return null;
  }

  function isMarketDay(dt = nowIst()) {
    const wd = dt.weekday;
    if (wd === 6 || wd === 7) return false;
    return !cfg.holidays.has(dt.toFormat("yyyy-LL-dd"));
  }

  function computeTodaySchedule(dt = nowIst()) {
    const warmupAt = hhmmToDate(dt, cfg.warmupHHMM);
    const liveAt = hhmmToDate(dt, cfg.liveHHMM);
    const closeAt = hhmmToDate(dt, cfg.closeHHMM);
    const idleAt = closeAt.plus({ minutes: Math.max(0, cfg.idleAfterMin) });
    return { warmupAt, liveAt, closeAt, idleAt };
  }

  function nextMarketDayStart(dt = nowIst()) {
    let probe = dt.plus({ days: 1 }).startOf("day");
    for (let i = 0; i < 10; i += 1) {
      if (isMarketDay(probe)) return hhmmToDate(probe, cfg.warmupHHMM);
      probe = probe.plus({ days: 1 });
    }
    return hhmmToDate(dt.plus({ days: 1 }).startOf("day"), cfg.warmupHHMM);
  }

  function getNextTransition(dt = nowIst()) {
    if (!isMarketDay(dt)) {
      return { nextAt: nextMarketDayStart(dt), nextState: "WARMUP" };
    }
    const s = computeTodaySchedule(dt);
    if (dt < s.warmupAt) return { nextAt: s.warmupAt, nextState: "WARMUP" };
    if (dt < s.liveAt) return { nextAt: s.liveAt, nextState: "LIVE" };
    if (dt < s.closeAt) return { nextAt: s.closeAt, nextState: "COOLDOWN" };
    if (dt < s.idleAt) return { nextAt: s.idleAt, nextState: "IDLE" };
    return { nextAt: nextMarketDayStart(dt), nextState: "WARMUP" };
  }

  function desiredStateAt(dt = nowIst()) {
    if (!isMarketDay(dt)) return "IDLE";
    const s = computeTodaySchedule(dt);
    if (dt < s.warmupAt) return "IDLE";
    if (dt < s.liveAt) return "WARMUP";
    if (dt < s.closeAt) return "LIVE";
    if (dt < s.idleAt) return "COOLDOWN";
    return "IDLE";
  }

  async function stopHeavy(reason) {
    await ops.setTradingEnabled?.(false, reason);
    await ops.stopSession?.(reason);
  }

  function normalizeWarmupReason(reason) {
    const base = String(reason || "scheduled").trim().toLowerCase().replace(/\s+/g, "_");
    return base.startsWith("warmup") ? base : `warmup_${base}`;
  }

  async function maybeStartSession(reason) {
    if (!token) return { ok: false, reason: "TOKEN_MISSING" };
    return ops.startSession?.(token, reason);
  }

  async function evaluateCooldown(now = nowIst()) {
    if (state !== "COOLDOWN") return;
    let flat = true;
    let openCount = null;
    try {
      const p = await ops.getOpenPositionsSummary?.();
      const hasError = !!p?.error;
      openCount = Number.isFinite(Number(p?.openCount)) ? Number(p.openCount) : null;
      flat = !hasError && openCount === 0;
    } catch {
      flat = false;
    }

    if (!cfg.requireFlat || flat) {
      await stopHeavy("cooldown_to_idle");
      state = "IDLE";
      await notifyLifecycle("IDLE_ENTER", { openCount });
      scheduleNext();
      return;
    }

    if (cfg.forceFlatten) {
      if (!forceFlattenStartedAt) {
        forceFlattenStartedAt = now.toMillis();
        await notifyLifecycle("FORCE_FLATTEN_START", { openCount });
        const flattenRes = await ops.forceFlatten?.("ENGINE_CLOSE_FORCE_FLATTEN");
        await notifyLifecycle("FORCE_FLATTEN_RESULT", {
          ok: !!flattenRes?.ok,
          openCount,
          timedOut: false,
          flatten: flattenRes || null,
        });
      }
      const deadlineMs = cfg.forceFlattenDeadlineMin * 60 * 1000;
      const timedOut = now.toMillis() - forceFlattenStartedAt >= deadlineMs;
      if (timedOut && !forceFlattenDeadlineHit) {
        forceFlattenDeadlineHit = true;
        await notifyLifecycle("FORCE_FLATTEN_RESULT", {
          ok: false,
          openCount,
          timedOut: true,
          action: "cooldown_deadline_forced_idle",
          deadlineMin: cfg.forceFlattenDeadlineMin,
        });
        await stopHeavy("cooldown_deadline_elapsed");
        state = "IDLE";
        await notifyLifecycle("IDLE_ENTER", {
          reason: "cooldown_deadline_elapsed",
          openCount,
        });
        scheduleNext();
        return;
      }
    }

    cooldownTimer = setTimeout(() => {
      void evaluateCooldown();
    }, Math.max(1, cfg.cooldownPollSec) * 1000);
    cooldownTimer.unref?.();
  }

  async function transit(target, reason = "schedule") {
    if (state === target) {
      scheduleNext();
      return;
    }
    logger.info({ from: state, to: target, reason }, "[lifecycle] transition");

    if (!token && target !== "IDLE") {
      state = "IDLE";
      await stopHeavy("token_missing");
      scheduleNext();
      return;
    }

    if (target === "WARMUP") {
      const res = await maybeStartSession(reason);
      if (!res?.ok && res?.reason === "TOKEN_MISSING") {
        state = "IDLE";
      } else {
        state = "WARMUP";
        const warmupReason = normalizeWarmupReason(reason);
        await ops.setTradingEnabled?.(false, warmupReason);
        await notifyLifecycle("WARMUP_START", { reason: warmupReason });
      }
    } else if (target === "LIVE") {
      await maybeStartSession(reason);
      state = "LIVE";
      await ops.setTradingEnabled?.(true, "live");
      await notifyLifecycle("LIVE_START", { reason });
    } else if (target === "COOLDOWN") {
      state = "COOLDOWN";
      await ops.setTradingEnabled?.(false, "close");
      const p = await ops.getOpenPositionsSummary?.();
      const openCount = Number.isFinite(Number(p?.openCount)) ? Number(p.openCount) : null;
      await notifyLifecycle("CLOSE_START", {
        openCount,
        flatCheckError: p?.error || null,
        requireFlat: cfg.requireFlat,
        forceFlatten: cfg.forceFlatten,
      });
      forceFlattenStartedAt = 0;
      forceFlattenDeadlineHit = false;
      await evaluateCooldown();
      return;
    } else {
      state = "IDLE";
      await stopHeavy("idle_transition");
      await notifyLifecycle("IDLE_ENTER", { reason });
    }

    scheduleNext();
  }

  async function reconcileNow(reason = "reconcile") {
    const target = desiredStateAt(nowIst());
    await transit(target, reason);
  }

  function scheduleNext() {
    wakeTimer = clearTimer(wakeTimer);
    cooldownTimer = clearTimer(cooldownTimer);

    const now = nowIst();
    const next = getNextTransition(now);
    nextTransitionAt = next.nextAt;
    const ms = Math.max(250, next.nextAt.toMillis() - now.toMillis());
    wakeTimer = setTimeout(() => {
      void transit(next.nextState, "scheduled");
    }, ms);
    wakeTimer.unref?.();
  }

  function startIdleGuard() {
    if (idleGuardTimer) return;
    idleGuardTimer = setInterval(() => {
      if (state !== "IDLE") return;
      const next = getNextTransition(nowIst());
      nextTransitionAt = next.nextAt;
    }, Math.max(5, cfg.idleGuardSec) * 1000);
    idleGuardTimer.unref?.();
  }

  function stop() {
    wakeTimer = clearTimer(wakeTimer);
    cooldownTimer = clearTimer(cooldownTimer);
    if (idleGuardTimer) {
      clearInterval(idleGuardTimer);
      idleGuardTimer = null;
    }
  }

  async function start() {
    if (!cfg.enabled) return;
    startIdleGuard();
    await reconcileNow("startup");
  }

  async function setToken(accessToken) {
    const had = !!token;
    const prevToken = token;
    token = accessToken ? String(accessToken) : null;
    if (!token && had) {
      await notifyLifecycle("TOKEN_MISSING", {});
      await transit("IDLE", "token_missing");
      return;
    }
    if (token && !had) {
      await notifyLifecycle("TOKEN_RESTORED", {});
      await reconcileNow("token_restored");
      return;
    }

    const tokenChanged = !!token && prevToken !== token;
    if (tokenChanged && (state === "WARMUP" || state === "LIVE" || state === "COOLDOWN")) {
      await maybeStartSession("token_updated");
    }

    if (token) {
      await reconcileNow("token_updated");
    }
  }

  function status() {
    return {
      enabled: cfg.enabled,
      mode: state,
      tokenPresent: !!token,
      nextTransitionAt: nextTransitionAt ? nextTransitionAt.toISO() : null,
      nowIst: nowIst().toISO(),
      schedule: computeTodaySchedule(nowIst()),
    };
  }

  return {
    start,
    stop,
    setToken,
    status,
    isMarketDay,
    computeTodaySchedule,
    getNextTransition,
  };
}

function createEngineLifecycle(ops) {
  _instance = makeLifecycle(ops);
  return _instance;
}

function getEngineLifecycleStatus() {
  return _instance?.status?.() || { enabled: false, mode: "LEGACY", tokenPresent: false, nextTransitionAt: null };
}

module.exports = { createEngineLifecycle, getEngineLifecycleStatus };
