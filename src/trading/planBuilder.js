const { DateTime } = require("luxon");

/**
 * Pro-style plan builder:
 *  - SL: structure + ATR (k by style), not too tight
 *  - Target: structure + ATR (m by style), reachable via expected move, meets minRR by style
 *  - Options: build plan on underlying, map to premium via abs(delta) approximation
 *
 * Returns:
 *  { ok, stopLoss, targetPrice, rr, expectedMovePerUnit, meta }
 */

function clamp(x, lo, hi) {
  const n = Number(x);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function safeNum(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function roundToTick(price, tick, mode = "nearest") {
  const t = safeNum(tick, 0.05) || 0.05;
  const p = Number(price);
  if (!Number.isFinite(p)) return p;
  const steps = p / t;
  if (mode === "up") return Math.ceil(steps) * t;
  if (mode === "down") return Math.floor(steps) * t;
  return Math.round(steps) * t;
}

function atrLast(candles, period = 14) {
  const p = Math.max(2, Number(period || 14));
  if (!Array.isArray(candles) || candles.length < p + 2) return null;
  let trs = [];
  for (let i = candles.length - p; i < candles.length; i += 1) {
    const c = candles[i];
    const prev = candles[i - 1];
    const high = safeNum(c?.high);
    const low = safeNum(c?.low);
    const prevClose = safeNum(prev?.close);
    if (
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(prevClose)
    )
      continue;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
    trs.push(tr);
  }
  if (!trs.length) return null;
  const avg = trs.reduce((a, b) => a + b, 0) / trs.length;
  return Number.isFinite(avg) ? avg : null;
}

function tz(env) {
  return env.CANDLE_TZ || "Asia/Kolkata";
}

function dayKey(ts, env) {
  return DateTime.fromMillis(Number(ts), { zone: tz(env) }).toFormat(
    "yyyy-LL-dd",
  );
}

function minutesOfDay(ts, env) {
  const dt = DateTime.fromMillis(Number(ts), { zone: tz(env) });
  return dt.hour * 60 + dt.minute;
}

function hhmmToMinutes(hhmm) {
  const s = String(hhmm || "").trim();
  const m = /^([0-2]?\d):([0-5]\d)$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function computePrevDayLevels(candles, env) {
  if (!Array.isArray(candles) || candles.length < 50) return null;

  const groups = new Map();
  for (const c of candles) {
    const ts = safeNum(c?.ts);
    if (!Number.isFinite(ts)) continue;
    const dk = dayKey(ts, env);
    if (!groups.has(dk)) groups.set(dk, []);
    groups.get(dk).push(c);
  }
  const keys = Array.from(groups.keys()).sort();
  if (keys.length < 2) return null;

  const prev = keys[keys.length - 2];
  const arr = groups.get(prev) || [];
  if (!arr.length) return null;

  let high = -Infinity,
    low = Infinity;
  for (const c of arr) {
    const h = safeNum(c?.high);
    const l = safeNum(c?.low);
    if (Number.isFinite(h)) high = Math.max(high, h);
    if (Number.isFinite(l)) low = Math.min(low, l);
  }
  const close = safeNum(arr[arr.length - 1]?.close);
  if (
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close)
  )
    return null;

  const P = (high + low + close) / 3;
  const R1 = 2 * P - low;
  const S1 = 2 * P - high;
  const R2 = P + (high - low);
  const S2 = P - (high - low);

  return {
    prevDayKey: prev,
    PDH: high,
    PDL: low,
    PDC: close,
    pivots: { P, R1, S1, R2, S2 },
  };
}

function vwap(candles, lookback = 120) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const n = Math.max(5, Number(lookback || 120));
  const tail = candles.slice(-n);
  let pv = 0;
  let v = 0;
  for (const c of tail) {
    const h = safeNum(c?.high);
    const l = safeNum(c?.low);
    const cl = safeNum(c?.close);
    const vol = safeNum(c?.volume, 0);
    if (
      !Number.isFinite(h) ||
      !Number.isFinite(l) ||
      !Number.isFinite(cl) ||
      !Number.isFinite(vol)
    )
      continue;
    const tp = (h + l + cl) / 3;
    pv += tp * vol;
    v += vol;
  }
  if (!v) return null;
  return pv / v;
}

function computeOpeningRange(candles, env, intervalMin) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const openMin = hhmmToMinutes(env.MARKET_OPEN || "09:15");
  if (openMin == null) return null;
  const win = Math.max(5, Number(env.SELECTOR_OPEN_WINDOW_MIN || 20));
  const endMin = openMin + win;
  const todayKey = dayKey(safeNum(candles[candles.length - 1]?.ts), env);

  const todays = candles.filter((c) => {
    const ts = safeNum(c?.ts);
    if (!Number.isFinite(ts)) return false;
    if (dayKey(ts, env) !== todayKey) return false;
    const m = minutesOfDay(ts, env);
    return m >= openMin && m < endMin;
  });

  if (todays.length < 2) return null;

  let high = -Infinity,
    low = Infinity;
  for (const c of todays) {
    const h = safeNum(c?.high);
    const l = safeNum(c?.low);
    if (Number.isFinite(h)) high = Math.max(high, h);
    if (Number.isFinite(l)) low = Math.min(low, l);
  }
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  return { high, low, count: todays.length, windowMin: win };
}

function styleOf(signalStyle) {
  const s = String(signalStyle || "").toUpperCase();
  if (s.includes("TREND")) return "TREND";
  if (s.includes("RANGE")) return "RANGE";
  if (s.includes("OPEN")) return "OPEN";
  return "DEFAULT";
}

function pickK(env, style) {
  if (style === "TREND") return safeNum(env.PLAN_SL_ATR_K_TREND, 0.8);
  if (style === "RANGE") return safeNum(env.PLAN_SL_ATR_K_RANGE, 0.6);
  if (style === "OPEN") return safeNum(env.PLAN_SL_ATR_K_OPEN, 1.0);
  return safeNum(env.PLAN_SL_ATR_K_DEFAULT, 0.8);
}

function pickM(env, style) {
  if (style === "TREND") return safeNum(env.PLAN_TARGET_ATR_M_TREND, 1.4);
  if (style === "RANGE") return safeNum(env.PLAN_TARGET_ATR_M_RANGE, 0.9);
  if (style === "OPEN") return safeNum(env.PLAN_TARGET_ATR_M_OPEN, 1.2);
  return safeNum(env.PLAN_TARGET_ATR_M_DEFAULT, 1.2);
}

function minRR(env, style) {
  if (style === "TREND") return safeNum(env.STYLE_MIN_RR_TREND, 1.6);
  if (style === "RANGE") return safeNum(env.STYLE_MIN_RR_RANGE, 1.3);
  if (style === "OPEN") return safeNum(env.STYLE_MIN_RR_OPEN, 1.4);
  return safeNum(env.STYLE_MIN_RR_DEFAULT, 1.4);
}

function optionAbsDelta(env, optionMeta) {
  const m = String(
    optionMeta?.moneyness || env.OPT_MONEYNESS || "ATM",
  ).toUpperCase();
  if (m === "ITM") return safeNum(env.OPT_DELTA_ITM, 0.65);
  if (m === "OTM") return safeNum(env.OPT_DELTA_OTM, 0.4);
  return safeNum(env.OPT_DELTA_ATM, 0.5);
}

function daysToExpiry(optionMeta) {
  const exp = optionMeta?.expiry;
  if (!exp) return null;
  const d = new Date(exp);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const diff = (d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  return Number.isFinite(diff) ? diff : null;
}

function buildTradePlan({
  env,
  candles,
  intervalMin,
  side, // underlying BUY/SELL
  signalStyle,
  entryUnderlying,
  expectedMoveUnderlying,
  atrPeriod,
  optionMeta, // if present => map to premium
  entryPremium,
  premiumTick,
  atrPctUnderlying,
}) {
  const dir = String(side || "").toUpperCase();
  if (dir !== "BUY" && dir !== "SELL")
    return { ok: false, reason: "invalid_side" };
  if (!Array.isArray(candles) || candles.length < 30)
    return { ok: false, reason: "insufficient_candles" };

  const style = styleOf(
    signalStyle || optionMeta?.strategyStyle || optionMeta?.style || null,
  );
  const k = pickK(env, style);
  const m = pickM(env, style);
  const minRr = minRR(env, style);

  const entryU = safeNum(entryUnderlying);
  if (!Number.isFinite(entryU) || entryU <= 0)
    return { ok: false, reason: "bad_entry" };

  const atr = safeNum(
    atrLast(candles, atrPeriod || safeNum(env.EXPECTED_MOVE_ATR_PERIOD, 14)),
    null,
  );
  const noiseMinMult = safeNum(env.PLAN_SL_NOISE_ATR_MIN_MULT, 0.25);

  const swingLookback = Math.max(20, Number(env.PLAN_SWING_LOOKBACK || 60));
  const rangeLookback = Math.max(20, Number(env.PLAN_RANGE_LOOKBACK || 30));

  const tailSwing = candles.slice(-swingLookback);
  const tailRange = candles.slice(-rangeLookback);

  const swingLow = Math.min(...tailSwing.map((c) => safeNum(c.low, Infinity)));
  const swingHigh = Math.max(
    ...tailSwing.map((c) => safeNum(c.high, -Infinity)),
  );

  const rangeLow = Math.min(...tailRange.map((c) => safeNum(c.low, Infinity)));
  const rangeHigh = Math.max(
    ...tailRange.map((c) => safeNum(c.high, -Infinity)),
  );

  const orb = computeOpeningRange(candles, env, intervalMin);

  const atrSL =
    dir === "BUY"
      ? entryU - (safeNum(atr, 0) || 0) * k
      : entryU + (safeNum(atr, 0) || 0) * k;

  const structureSL =
    dir === "BUY"
      ? Math.min(
          Number.isFinite(swingLow) ? swingLow : Infinity,
          Number.isFinite(rangeLow) ? rangeLow : Infinity,
          Number.isFinite(orb?.low) ? orb.low : Infinity,
        )
      : Math.max(
          Number.isFinite(swingHigh) ? swingHigh : -Infinity,
          Number.isFinite(rangeHigh) ? rangeHigh : -Infinity,
          Number.isFinite(orb?.high) ? orb.high : -Infinity,
        );

  let stopU = Number.isFinite(structureSL) ? structureSL : atrSL;
  let slReason = Number.isFinite(structureSL) ? "STRUCTURE" : "ATR";

  if (dir === "BUY" && stopU >= entryU) {
    stopU = atrSL;
    slReason = "ATR_FALLBACK";
  }
  if (dir === "SELL" && stopU <= entryU) {
    stopU = atrSL;
    slReason = "ATR_FALLBACK";
  }

  if (Number.isFinite(atr) && atr > 0) {
    const riskU = Math.abs(entryU - stopU);
    if (riskU < noiseMinMult * atr) {
      stopU = atrSL;
      slReason = "ATR_NOISE_WIDEN";
    }
  }

  // Targets
  const prev = computePrevDayLevels(candles, env);
  const vw = vwap(candles, safeNum(env.VWAP_LOOKBACK, 120));
  const rangeMid =
    Number.isFinite(rangeHigh) && Number.isFinite(rangeLow)
      ? (rangeHigh + rangeLow) / 2
      : null;

  const atrTargetU =
    dir === "BUY"
      ? entryU + (safeNum(atr, 0) || 0) * m
      : entryU - (safeNum(atr, 0) || 0) * m;

  const candidates = [];
  const add = (level, tag) => {
    const lv = safeNum(level);
    if (!Number.isFinite(lv)) return;
    candidates.push({ level: lv, tag });
  };

  if (dir === "BUY") {
    add(prev?.PDH, "PDH");
    add(prev?.pivots?.R1, "R1");
    add(prev?.pivots?.R2, "R2");
    add(swingHigh, "SWING_HIGH");
    add(rangeHigh, "RANGE_HIGH");
    if (style === "RANGE") {
      add(vw, "VWAP");
      add(rangeMid, "RANGE_MID");
    }
    add(atrTargetU, "ATR_TARGET");
  } else {
    add(prev?.PDL, "PDL");
    add(prev?.pivots?.S1, "S1");
    add(prev?.pivots?.S2, "S2");
    add(swingLow, "SWING_LOW");
    add(rangeLow, "RANGE_LOW");
    if (style === "RANGE") {
      add(vw, "VWAP");
      add(rangeMid, "RANGE_MID");
    }
    add(atrTargetU, "ATR_TARGET");
  }

  const filtered = candidates
    .filter((c) => (dir === "BUY" ? c.level > entryU : c.level < entryU))
    .sort((a, b) => Math.abs(a.level - entryU) - Math.abs(b.level - entryU));

  const R = Math.abs(entryU - stopU);
  if (!Number.isFinite(R) || R <= 0) return { ok: false, reason: "bad_stop" };

  const em = safeNum(expectedMoveUnderlying, null);
  const reachMult = safeNum(env.PLAN_TARGET_EXPECTED_MOVE_MULT, 1.3);

  let chosen = null;
  for (const cand of filtered) {
    const dist = Math.abs(cand.level - entryU);
    if (Number.isFinite(em) && em > 0 && dist > em * reachMult) continue;
    const rr = dist / R;
    if (rr >= minRr) {
      chosen = { ...cand, rr, dist, R };
      break;
    }
  }

  if (!chosen) {
    const dist = Math.abs(atrTargetU - entryU);
    const rr = dist / R;
    if (rr >= minRr && Number.isFinite(dist) && dist > 0) {
      chosen = { level: atrTargetU, tag: "ATR_TARGET_FALLBACK", rr, dist, R };
    }
  }

  if (!chosen)
    return { ok: false, reason: "no_target_meets_minRR", meta: { minRr, R } };

  const targetU = chosen.level;
  const rrUnderlying = chosen.rr;

  let stop = stopU;
  let target = targetU;
  let rrFinal = rrUnderlying;
  let expectedMovePerUnit = em;

  const meta = {
    style,
    k,
    m,
    minRr,
    slReason,
    targetReason: chosen.tag,
    rrUnderlying,
    underlying: { entry: entryU, stop: stopU, target: targetU, R },
    prevDay: prev
      ? {
          PDH: prev.PDH,
          PDL: prev.PDL,
          pivots: prev.pivots,
          prevDayKey: prev.prevDayKey,
        }
      : null,
    vwap: Number.isFinite(vw) ? vw : null,
    orb,
  };

  if (optionMeta) {
    const premEntry = safeNum(entryPremium);
    if (!Number.isFinite(premEntry) || premEntry <= 0)
      return { ok: false, reason: "bad_premium_entry" };

    const absDelta = clamp(optionAbsDelta(env, optionMeta), 0.2, 0.9);
    const dte = daysToExpiry(optionMeta);
    const near = Number.isFinite(dte) ? clamp((3 - dte) / 3, 0, 1) : 0;

    const atrPct = safeNum(atrPctUnderlying, null);
    const volRef = safeNum(env.OPT_VOL_REF_ATR_PCT, 0.6);
    const volFactor =
      Number.isFinite(atrPct) && Number.isFinite(volRef) && volRef > 0
        ? clamp(atrPct / volRef, 0.6, 1.8)
        : 1.0;

    // Tighten stop near expiry/high vol (safer)
    const stopScale = clamp(1 - 0.25 * near - 0.1 * (volFactor - 1), 0.65, 1.0);
    const targetScale = clamp(
      1 + 0.15 * near,
      1.0,
      safeNum(env.OPT_GAMMA_SCALE_MAX, 1.25),
    );

    const underlyingRisk = Math.abs(entryU - stopU);
    const underlyingReward = Math.abs(targetU - entryU);

    const premDrop = underlyingRisk * absDelta * stopScale;
    const premGain = underlyingReward * absDelta * targetScale;

    let stopP = premEntry - premDrop;
    let targetP = premEntry + premGain;

    // Max loss cap on premium
    const maxSlPct = safeNum(env.OPT_MAX_SL_PCT, 35);
    const maxDrop = premEntry * (maxSlPct / 100);
    if (premEntry - stopP > maxDrop) stopP = premEntry - maxDrop;

    const t = safeNum(premiumTick, 0.05);
    stopP = roundToTick(stopP, t, "down");
    targetP = roundToTick(targetP, t, "up");

    if (stopP >= premEntry)
      stopP = roundToTick(
        premEntry - Math.max(0.05, premEntry * 0.08),
        t,
        "down",
      );
    if (targetP <= premEntry)
      targetP = roundToTick(
        premEntry + Math.max(0.05, premEntry * 0.12),
        t,
        "up",
      );

    const Rp = Math.abs(premEntry - stopP);
    const rrP = Math.abs(targetP - premEntry) / (Rp || 1e-9);

    stop = stopP;
    target = targetP;
    rrFinal = rrP;

    expectedMovePerUnit = Number.isFinite(em) ? em * absDelta : null;

    meta.option = {
      absDelta,
      daysToExpiry: Number.isFinite(dte) ? dte : null,
      stopScale,
      targetScale,
      entryPremium: premEntry,
      stopPremium: stopP,
      targetPremium: targetP,
      rrPremium: rrP,
      volFactor,
    };
  }

  return {
    ok: true,
    stopLoss: stop,
    targetPrice: target,
    rr: rrFinal,
    expectedMovePerUnit,
    meta,
  };
}

module.exports = { buildTradePlan };
