// Tiny CSV parser (RFC4180-ish) with quote support.
// No external deps to keep the project lightweight.

function normalizeLineEndings(s) {
  return String(s || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function parseCsvRows(text) {
  const s = normalizeLineEndings(text);
  const rows = [];
  let row = [];
  let field = "";
  let i = 0;
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };

  const pushRow = () => {
    // Ignore trailing empty last row
    if (row.length === 1 && row[0] === "" && !rows.length) {
      row = [];
      return;
    }
    rows.push(row);
    row = [];
  };

  while (i < s.length) {
    const ch = s[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = s[i + 1];
        if (next === '"') {
          // Escaped quote
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (ch === ",") {
      pushField();
      i += 1;
      continue;
    }

    if (ch === "\n") {
      pushField();
      pushRow();
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  // Flush last field/row
  pushField();
  if (row.length) pushRow();

  return rows;
}

function parseCsvToObjects(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => String(h || "").trim());
  const out = [];
  for (let i = 1; i < rows.length; i += 1) {
    const r = rows[i];
    if (!r || !r.length) continue;
    // Skip fully empty lines
    if (r.every((x) => String(x || "").trim() === "")) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c += 1) {
      const k = headers[c] || `col_${c}`;
      obj[k] = r[c] ?? "";
    }
    out.push(obj);
  }
  return out;
}

module.exports = {
  parseCsvRows,
  parseCsvToObjects,
};
