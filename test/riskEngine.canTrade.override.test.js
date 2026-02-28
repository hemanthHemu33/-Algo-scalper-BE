const { DateTime } = require("luxon");

describe("RiskEngine canTrade ctx overrides", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    process.env.HOLIDAY_CALENDAR_ENABLED = "false";
    process.env.SPECIAL_SESSIONS_ENABLED = "false";
    process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/test";
    process.env.MONGO_DB = process.env.MONGO_DB || "test";
    process.env.KITE_API_KEY = process.env.KITE_API_KEY || "test_key";
    process.env.CANDLE_TZ = "Asia/Kolkata";
    process.env.MARKET_OPEN = "09:15";
    process.env.MARKET_CLOSE = "15:30";
    process.env.STOP_NEW_ENTRIES_AFTER = "15:00";
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("allows after cutoff only up to provided allow-until", () => {
    const nowMs = DateTime.fromISO("2025-01-15T15:05:00", {
      zone: "Asia/Kolkata",
    }).toMillis();
    const { RiskEngine } = require("../src/risk/riskEngine");
    const engine = new RiskEngine({ clock: { nowMs: () => nowMs } });

    const blocked = engine.canTrade("NIFTY:ema_cross");
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe("after_entry_cutoff");

    const allowed = engine.canTrade("NIFTY:ema_cross", {
      allowAfterEntryCutoffUntil: "15:10",
    });
    expect(allowed.ok).toBe(true);

    const denied = engine.canTrade("NIFTY:ema_cross", {
      allowAfterEntryCutoffUntil: "15:04",
    });
    expect(denied.ok).toBe(false);
    expect(denied.reason).toBe("after_entry_cutoff");
  });

  test("ignoreCooldown bypasses only cooldown block", () => {
    const nowMs = DateTime.fromISO("2025-01-15T14:00:00", {
      zone: "Asia/Kolkata",
    }).toMillis();
    const { RiskEngine } = require("../src/risk/riskEngine");
    const engine = new RiskEngine({ clock: { nowMs: () => nowMs } });

    engine.setCooldown("NIFTY:ema_cross", 300, "test");

    const blocked = engine.canTrade("NIFTY:ema_cross");
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe("cooldown");

    const allowed = engine.canTrade("NIFTY:ema_cross", {
      ignoreCooldown: true,
    });
    expect(allowed.ok).toBe(true);
  });
});
