function avg(arr) {
  if (!arr || !arr.length) return 0;
  const s = arr.reduce((a, b) => a + Number(b ?? 0), 0);
  return s / arr.length;
}

function avgVolume(candles, lookback = 20) {
  const slice = (candles || []).slice(-lookback);
  return avg(slice.map((c) => Number(c.volume ?? 0)));
}

function rollingVWAP(candles, lookback = 120) {
  const slice = (candles || []).slice(-lookback);
  let tpv = 0;
  let v = 0;
  for (const c of slice) {
    const vol = Number(c.volume ?? 0);
    const tp = (Number(c.high) + Number(c.low) + Number(c.close)) / 3;
    tpv += tp * vol;
    v += vol;
  }
  return v > 0 ? tpv / v : Number(slice[slice.length - 1]?.close ?? 0);
}

/**
 * ✅ FIX: maxHigh/minLow must support lookback, because selector.js calls:
 * maxHigh(candles, lookback) / minLow(candles, lookback)
 */
function maxHigh(candles, lookback = 0) {
  const arr = Array.isArray(candles) ? candles : [];
  const lb = Number(lookback ?? 0);
  const use = lb > 0 ? arr.slice(-lb) : arr;

  let m = -Infinity;
  for (const c of use) {
    const h = Number(c?.high);
    if (Number.isFinite(h) && h > m) m = h;
  }
  // return 0 if no valid highs found (safe fallback)
  return Number.isFinite(m) ? m : 0;
}

function minLow(candles, lookback = 0) {
  const arr = Array.isArray(candles) ? candles : [];
  const lb = Number(lookback ?? 0);
  const use = lb > 0 ? arr.slice(-lb) : arr;

  let m = Infinity;
  for (const c of use) {
    const l = Number(c?.low);
    if (Number.isFinite(l) && l < m) m = l;
  }
  // return 0 if no valid lows found (safe fallback)
  return Number.isFinite(m) ? m : 0;
}

function sma(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(-period);
  return avg(slice);
}

function stddev(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(-period);
  const m = avg(slice);
  const v = avg(
    slice.map((x) => {
      const d = Number(x) - m;
      return d * d;
    })
  );
  return Math.sqrt(v);
}

function bollingerBands(candles, period = 20, std = 2) {
  const closes = (candles || []).map((c) => Number(c.close));
  const mid = sma(closes, period);
  const sd = stddev(closes, period);
  if (mid == null || sd == null) return null;
  const upper = mid + std * sd;
  const lower = mid - std * sd;
  const widthPct = mid !== 0 ? (upper - lower) / mid : 0;
  return { mid, upper, lower, widthPct };
}

function rsi(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const closes = candles.map((c) => Number(c.close));

  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function candleBody(c) {
  const o = Number(c.open);
  const cl = Number(c.close);
  return Math.abs(cl - o);
}

function candleRange(c) {
  return Math.max(0, Number(c.high) - Number(c.low));
}

function upperWick(c) {
  const hi = Number(c.high);
  const top = Math.max(Number(c.open), Number(c.close));
  return Math.max(0, hi - top);
}

function lowerWick(c) {
  const lo = Number(c.low);
  const bot = Math.min(Number(c.open), Number(c.close));
  return Math.max(0, bot - lo);
}

function atr(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  let sum = 0;

  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = Number(candles[i - 1]?.close);
    const high = Number(c.high);
    const low = Number(c.low);

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    sum += Number.isFinite(tr) ? tr : 0;
  }

  return sum / period;
}

function percentileRank(values, x) {
  if (!values || !values.length) return null;
  const v = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!v.length) return null;

  const n = v.length;
  let count = 0;
  for (const a of v) {
    if (a <= x) count += 1;
  }
  return (count / n) * 100;
}

module.exports = {
  avgVolume,
  rollingVWAP,
  maxHigh,
  minLow,
  sma,
  stddev,
  bollingerBands,
  rsi,
  candleBody,
  candleRange,
  upperWick,
  lowerWick,
  atr,
  percentileRank,
};
