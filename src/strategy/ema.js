function emaSeries(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);

  const out = [];
  let prev = values[0];
  out.push(prev);

  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    const next = (v * k) + (prev * (1 - k));
    out.push(next);
    prev = next;
  }
  return out;
}

module.exports = { emaSeries };
