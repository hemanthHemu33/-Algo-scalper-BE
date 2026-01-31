// greeks.js
// Lightweight Black-Scholes greeks + implied-vol solver for intraday options routing.
// Notes:
// - No dividends.
// - Vega returned as price change per 1.0 (100 vol points) change in sigma.
//   We also provide vegaPer1Pct = vega * 0.01.
// - Theta returned as price change per year (calendar year). We derive per-day.

function clamp(x, a, b) {
  const v = Number(x);
  if (!Number.isFinite(v)) return a;
  return Math.min(b, Math.max(a, v));
}

// Abramowitz & Stegun approximation for erf
function erf(x) {
  // save the sign of x
  const sign = x >= 0 ? 1 : -1;
  const ax = Math.abs(x);

  // constants
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1.0 / (1.0 + p * ax);
  const y =
    1.0 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) *
      Math.exp(-ax * ax);

  return sign * y;
}

function normCdf(x) {
  // Abramowitz & Stegun approximation
  const v = Number(x);
  if (!Number.isFinite(v)) return 0.5;
  const a1 = 0.319381530;
  const a2 = -0.356563782;
  const a3 = 1.781477937;
  const a4 = -1.821255978;
  const a5 = 1.330274429;
  const p = 0.2316419;
  const sign = v < 0 ? -1 : 1;
  const xAbs = Math.abs(v);
  const t = 1 / (1 + p * xAbs);
  const pdf = 0.3989422804014327 * Math.exp(-0.5 * xAbs * xAbs);
  const poly = ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t;
  const approx = 1 - pdf * poly;
  return sign < 0 ? 1 - approx : approx;
}

function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function bsD1(S, K, r, sigma, T) {
  return (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
}

function bsD2(d1, sigma, T) {
  return d1 - sigma * Math.sqrt(T);
}

function bsPrice({ S, K, r, sigma, T, isCall }) {
  if (!(S > 0) || !(K > 0) || !(sigma > 0) || !(T > 0)) return null;
  const d1 = bsD1(S, K, r, sigma, T);
  const d2 = bsD2(d1, sigma, T);
  const df = Math.exp(-r * T);
  if (isCall) {
    return S * normCdf(d1) - K * df * normCdf(d2);
  }
  // put
  return K * df * normCdf(-d2) - S * normCdf(-d1);
}

function bsGreeks({ S, K, r, sigma, T, isCall }) {
  if (!(S > 0) || !(K > 0) || !(sigma > 0) || !(T > 0)) return null;

  const d1 = bsD1(S, K, r, sigma, T);
  const d2 = bsD2(d1, sigma, T);

  const pdf = normPdf(d1);
  const df = Math.exp(-r * T);

  const delta = isCall ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = pdf / (S * sigma * Math.sqrt(T));
  const vega = S * pdf * Math.sqrt(T); // per 1.0 vol change

  // theta per year (continuous)
  // call: -S*pdf*sigma/(2*sqrt(T)) - r*K*df*N(d2)
  // put:  -S*pdf*sigma/(2*sqrt(T)) + r*K*df*N(-d2)
  const term1 = (-S * pdf * sigma) / (2 * Math.sqrt(T));
  const term2 = isCall
    ? -r * K * df * normCdf(d2)
    : r * K * df * normCdf(-d2);
  const theta = term1 + term2;

  return { delta, gamma, vega, theta };
}

function impliedVolBisection({
  S,
  K,
  r,
  T,
  isCall,
  marketPrice,
  maxIter = 60,
  tol = 1e-4,
}) {
  const mp = Number(marketPrice);
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(mp > 0)) return null;

  // intrinsic lower bound
  const df = Math.exp(-r * T);
  const intrinsic = isCall
    ? Math.max(0, S - K * df)
    : Math.max(0, K * df - S);
  if (mp < intrinsic - 1e-6) {
    // market price below intrinsic -> no valid IV
    return null;
  }

  let lo = 1e-6;
  let hi = 5.0; // 500% vol upper bound

  let pLo = bsPrice({ S, K, r, sigma: lo, T, isCall });
  let pHi = bsPrice({ S, K, r, sigma: hi, T, isCall });
  if (pLo == null || pHi == null) return null;

  // If even huge vol can't reach market price, bail
  if (pHi < mp) return null;

  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const pm = bsPrice({ S, K, r, sigma: mid, T, isCall });
    if (pm == null) return null;

    const err = pm - mp;
    if (Math.abs(err) < tol) return mid;

    if (err > 0) {
      hi = mid;
    } else {
      lo = mid;
    }

    // tiny interval
    if (hi - lo < 1e-6) break;
  }

  return (lo + hi) / 2;
}

function computeGreeksFromMarket({
  S,
  K,
  r,
  T,
  isCall,
  marketPrice,
}) {
  const sigma = impliedVolBisection({ S, K, r, T, isCall, marketPrice });
  if (!(sigma > 0)) return null;
  const g = bsGreeks({ S, K, r, sigma, T, isCall });
  if (!g) return null;

  const vegaPer1Pct = g.vega * 0.01;
  const thetaPerDay = g.theta / 365;

  return {
    iv: sigma,
    delta: g.delta,
    gamma: g.gamma,
    vega: g.vega,
    vegaPer1Pct,
    theta: g.theta,
    thetaPerDay,
  };
}

module.exports = {
  clamp,
  computeGreeksFromMarket,
  bsPrice,
  bsGreeks,
  impliedVolBisection,
};
