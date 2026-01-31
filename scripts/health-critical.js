/*
 * PATCH-10: Quick CLI probe for /admin/health/critical
 *
 * Usage:
 *   npm run health:critical
 *
 * Notes:
 * - In production, set ADMIN_API_KEY in env; this script will send it as x-api-key.
 */

const http = require("http");
const { env } = require("../src/config");

async function main() {
  const host = process.env.HEALTH_HOST || "localhost";
  const port = Number(process.env.HEALTH_PORT || env.PORT || 4001);
  const headers = {};
  if (env.ADMIN_API_KEY) headers["x-api-key"] = env.ADMIN_API_KEY;

  const opts = {
    host,
    port,
    path: "/admin/health/critical",
    method: "GET",
    headers,
    timeout: 8000,
  };

  const req = http.request(opts, (res) => {
    let buf = "";
    res.on("data", (d) => (buf += d));
    res.on("end", () => {
      let json = null;
      try {
        json = JSON.parse(buf || "{}");
      } catch {
        json = { ok: false, error: "invalid_json" };
      }

      const ok = res.statusCode === 200 && json && json.ok === true;
      console.log({ statusCode: res.statusCode, ok: !!(json && json.ok), checks: json.checks || null });
      process.exit(ok ? 0 : 2);
    });
  });

  req.on("timeout", () => {
    req.destroy(new Error("timeout"));
  });

  req.on("error", (e) => {
    console.error("critical health probe failed", e?.message || e);
    process.exit(9);
  });

  req.end();
}

main();
