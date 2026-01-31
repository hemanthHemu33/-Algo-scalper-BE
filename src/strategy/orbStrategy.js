const { DateTime } = require("luxon");
const { env } = require("../config");
const { avgVolume, maxHigh, minLow } = require("./utils");

/**
 * Opening Range Breakout (ORB)
 * - Opening range from 09:15 for ORB_MINUTES
 * - Trade breakout beyond range with volume confirmation
 */
function orbStrategy({ candles, intervalMin, orbMinutes = 15, volMult = 1.2, volLookback = 20 }) {
  if (!candles || candles.length < 40) return null;

  const tz = env.CANDLE_TZ || "Asia/Kolkata";
  const last = candles[candles.length - 1];

  const dtLast = DateTime.fromJSDate(new Date(last.ts)).setZone(tz);
  const sessionStart = dtLast
    .startOf("day")
    .set({ hour: 9, minute: 15, second: 0, millisecond: 0 });
  const end = sessionStart.plus({ minutes: Number(orbMinutes) });

  const needBars = Math.max(
    1,
    Math.ceil(Number(orbMinutes) / Math.max(1, Number(intervalMin || 1)))
  );

  const opening = candles.filter((c) => {
    const d = DateTime.fromJSDate(new Date(c.ts)).setZone(tz);
    return d >= sessionStart && d < end;
  });

  if (opening.length < needBars) return null;

  const now = DateTime.fromJSDate(new Date(last.ts)).setZone(tz);
  if (now < end) return null; // don't trigger before ORB completes

  const orbHigh = maxHigh(opening);
  const orbLow = minLow(opening);

  const close = Number(last.close);
  const vol = Number(last.volume || 0);
  const av = avgVolume(candles, volLookback) || 1;

  if (close > orbHigh && vol >= av * volMult) {
    const confidence = Math.min(95, 70 + Math.max(0, (vol / av - volMult) * 10));
    return {
      side: "BUY",
      confidence,
      reason: `ORB breakout above ${orbHigh.toFixed(2)} (ORB ${orbMinutes}m), vol ${Math.round(vol)} >= ${Math.round(av * volMult)}`,
    };
  }

  if (close < orbLow && vol >= av * volMult) {
    const confidence = Math.min(95, 70 + Math.max(0, (vol / av - volMult) * 10));
    return {
      side: "SELL",
      confidence,
      reason: `ORB breakdown below ${orbLow.toFixed(2)} (ORB ${orbMinutes}m), vol ${Math.round(vol)} >= ${Math.round(av * volMult)}`,
    };
  }

  return null;
}

module.exports = { orbStrategy };
