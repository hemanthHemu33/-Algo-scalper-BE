/*
 * PATCH-6 — Contract Note / Tradebook cost reconciler
 *
 * Purpose:
 *  - Ingest actual charges from broker CSV exports (Zerodha Tradebook / Contract Note)
 *  - Join rows to your own trades via order_id -> order_links -> trades
 *  - Compare actual vs base-estimated costs and auto-calibrate a per-segment multiplier
 *
 * Usage:
 *   node scripts/reconcile_contract_notes.js --file ./tradebook.csv --label "Jan-27"
 *   node scripts/reconcile_contract_notes.js --dir ./reports --label "week-4"
 */

const fs = require("fs");
const path = require("path");
const { connectMongo } = require("../src/db");
const { env } = require("../src/config");
const { ensureTradeIndexes } = require("../src/trading/tradeStore");
const { costCalibrator } = require("../src/trading/costCalibrator");
const { reconcileChargesFromFiles } = require("../src/reconcile/contractNoteReconciler");

function parseArgs(argv) {
  const args = { files: [], dir: null, label: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--file" && argv[i + 1]) {
      args.files.push(argv[i + 1]);
      i += 1;
      continue;
    }
    if (a === "--dir" && argv[i + 1]) {
      args.dir = argv[i + 1];
      i += 1;
      continue;
    }
    if (a === "--label" && argv[i + 1]) {
      args.label = argv[i + 1];
      i += 1;
      continue;
    }
    if (a === "--help" || a === "-h") {
      // eslint-disable-next-line no-console
      console.log(
        "Usage: node scripts/reconcile_contract_notes.js --file <csv> [--file <csv2> ...] [--dir <folder>] [--label <name>]",
      );
      process.exit(0);
    }
  }
  return args;
}

function listCsvFiles(dirPath) {
  const p = path.resolve(String(dirPath));
  if (!fs.existsSync(p)) return [];
  const entries = fs.readdirSync(p);
  return entries
    .filter((f) => f.toLowerCase().endsWith(".csv"))
    .map((f) => path.join(p, f));
}

async function main() {
  const args = parseArgs(process.argv);

  const files = [...(args.files || [])];
  if (args.dir) files.push(...listCsvFiles(args.dir));

  if (!files.length) {
    // eslint-disable-next-line no-console
    console.error("No CSV files specified. Use --file or --dir. Run with --help.");
    process.exit(2);
  }

  if (String(env.COST_CALIBRATION_ENABLED || "false") !== "true") {
    // eslint-disable-next-line no-console
    console.error(
      "COST_CALIBRATION_ENABLED is false. Set COST_CALIBRATION_ENABLED=true in your .env to persist calibration multipliers.",
    );
    process.exit(2);
  }

  await connectMongo();
  await ensureTradeIndexes();
  await costCalibrator.start();

  const out = await reconcileChargesFromFiles({ files, label: args.label });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
