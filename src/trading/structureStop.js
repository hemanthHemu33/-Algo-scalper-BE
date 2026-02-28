function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function lastBars(candles, bars) {
  return Array.isArray(candles) ? candles.slice(-Math.max(1, bars)) : [];
}

function parsePriority(raw) {
  return String(raw || "VWAP,ORB,DAY,PREV_DAY,WEEK")
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
}

function confirmBreakout({ side, level, candles, mode, bars }) {
  const xs = lastBars(candles, bars);
  if (!xs.length || !Number.isFinite(level)) return { ok: false };
  const m = String(mode || "CLOSE").toUpperCase();
  if (m === "WICK") {
    const ok = xs.every((c) => {
      const hi = n(c.high);
      const lo = n(c.low);
      if (side === "BUY") return Number.isFinite(hi) && hi > level;
      return Number.isFinite(lo) && lo < level;
    });
    return { ok };
  }
  const ok = xs.every((c) => {
    const cl = n(c.close);
    if (side === "BUY") return Number.isFinite(cl) && cl > level;
    return Number.isFinite(cl) && cl < level;
  });
  return { ok };
}

function computeStructureStopFloor({
  side,
  ltp,
  peakLtp,
  tick,
  atrPts,
  levels,
  candles,
  env,
  nowTs,
}) {
  const dir = String(side || "BUY").toUpperCase();
  const px = n(ltp);
  const peak = n(peakLtp) ?? px;
  const t = Math.max(Number(tick) || 0.05, 0.0001);
  if (!(dir === "BUY" || dir === "SELL") || !(px > 0)) {
    return { ok: false, reason: "invalid_inputs" };
  }

  const bufferPts = Math.max((Number(env.ANCHOR_BUFFER_TICKS ?? 2) || 2) * t, t);
  const minGapPts = Math.max(
    Number.isFinite(Number(atrPts)) && Number(atrPts) > 0
      ? Number(atrPts) * Math.max(0, Number(env.ANCHOR_MIN_GAP_ATR_MULT ?? 0.3))
      : 0,
    Math.max(1, Number(env.ANCHOR_MIN_GAP_TICKS ?? 10)) * t,
  );

  const orbMode = String(env.ORB_CONFIRM_MODE || "CLOSE").toUpperCase();
  const orbBars = Math.max(1, Number(env.ORB_CONFIRM_BARS ?? 1));
  const vwapMode = String(env.VWAP_CONFIRM_MODE || "CLOSE").toUpperCase();
  const vwapBars = Math.max(1, Number(env.VWAP_CONFIRM_BARS ?? 1));

  const candidates = [];
  const add = ({ type, level, enabled, breakout, mode, bars }) => {
    const lv = n(level);
    if (!enabled) {
      candidates.push({ type, stop: null, level: lv, bufferPts, valid: false, why: "disabled" });
      return;
    }
    if (!Number.isFinite(lv)) {
      candidates.push({ type, stop: null, level: lv, bufferPts, valid: false, why: "missing_level" });
      return;
    }
    if (breakout) {
      const cond = dir === "BUY" ? px > lv : px < lv;
      if (!cond) {
        candidates.push({ type, stop: null, level: lv, bufferPts, valid: false, why: "not_breakout" });
        return;
      }
    }
    const conf = confirmBreakout({ side: dir, level: lv, candles, mode, bars });
    if (!conf.ok) {
      candidates.push({ type, stop: null, level: lv, bufferPts, valid: false, why: "confirm_failed" });
      return;
    }

    const stop = dir === "BUY" ? lv - bufferPts : lv + bufferPts;
    const tooTight = dir === "BUY" ? stop > peak - minGapPts : stop < peak + minGapPts;
    if (tooTight) {
      candidates.push({ type, stop, level: lv, bufferPts, valid: false, why: "too_tight_vs_atr" });
      return;
    }
    candidates.push({ type, stop, level: lv, bufferPts, valid: true, why: "ok", confirm: { mode, bars, ok: true } });
  };

  add({
    type: "VWAP",
    level: levels?.vwap,
    enabled: String(env.VWAP_ENABLED ?? "true") === "true",
    breakout: false,
    mode: vwapMode,
    bars: vwapBars,
  });
  add({
    type: "ORB",
    level: dir === "BUY" ? levels?.orbHigh : levels?.orbLow,
    enabled: String(env.ORB_ENABLED ?? "true") === "true",
    breakout: true,
    mode: orbMode,
    bars: orbBars,
  });
  add({
    type: "DAY",
    level: dir === "BUY" ? levels?.dayHigh : levels?.dayLow,
    enabled: String(env.DAY_LEVELS_ENABLED ?? "true") === "true",
    breakout: true,
    mode: orbMode,
    bars: orbBars,
  });
  add({
    type: "PREV_DAY",
    level: dir === "BUY" ? levels?.prevDayHigh : levels?.prevDayLow,
    enabled: String(env.PREV_DAY_LEVELS_ENABLED ?? "false") === "true",
    breakout: true,
    mode: orbMode,
    bars: orbBars,
  });
  add({
    type: "WEEK",
    level: dir === "BUY" ? levels?.weekHigh : levels?.weekLow,
    enabled: String(env.WEEK_LEVELS_ENABLED ?? "false") === "true",
    breakout: true,
    mode: orbMode,
    bars: orbBars,
  });

  const valid = candidates.filter((c) => c.valid && Number.isFinite(c.stop));
  if (!valid.length) return { ok: false, reason: "no_valid_candidates", candidates };

  const rank = parsePriority(env.ANCHOR_PRIORITY);
  const byPriority = valid.sort((a, b) => {
    const pa = rank.indexOf(a.type);
    const pb = rank.indexOf(b.type);
    const va = pa >= 0 ? pa : 999;
    const vb = pb >= 0 ? pb : 999;
    if (va !== vb) return va - vb;
    return 0;
  });

  const bestStop =
    dir === "BUY"
      ? Math.max(...valid.map((c) => c.stop))
      : Math.min(...valid.map((c) => c.stop));
  const chosen = byPriority.find((c) => c.stop === bestStop) || byPriority[0];

  return {
    ok: true,
    structureStop: bestStop,
    chosen: {
      type: chosen.type,
      level: chosen.level,
      bufferPts: chosen.bufferPts,
      confirm: chosen.confirm || { mode: orbMode, bars: orbBars, ok: true },
    },
    candidates,
  };
}

module.exports = { computeStructureStopFloor };
