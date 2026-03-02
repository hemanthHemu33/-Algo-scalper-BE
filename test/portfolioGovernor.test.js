const {
  PortfolioGovernor,
  PORTFOLIO_GOVERNOR_COLLECTION,
} = require("../src/risk/portfolioGovernor");

class UniqueDateCollection {
  constructor(seed = [], { throwOnDateWrite = false } = {}) {
    this.rows = new Map();
    this.updateCalls = [];
    this.throwOnDateWrite = throwOnDateWrite;
    this.name = PORTFOLIO_GOVERNOR_COLLECTION;
    for (const row of seed) {
      this.rows.set(String(row.date), { ...row });
    }
  }

  async findOne(query) {
    return this.rows.get(String(query.date)) || null;
  }

  async updateOne(filter, update) {
    this.updateCalls.push({ filter, update });
    const key = String(filter.date);
    if (this.throwOnDateWrite) {
      const err = new Error("E11000 duplicate key error");
      err.code = 11000;
      throw err;
    }
    if (update?.$set?.createdAt && update?.$setOnInsert?.createdAt) {
      throw new Error("Updating the path 'createdAt' would create a conflict at 'createdAt'");
    }
    const prev = this.rows.get(key) || {};
    const next = {
      ...prev,
      ...(update.$setOnInsert || {}),
      ...(update.$set || {}),
    };
    this.rows.set(key, next);
  }
}

class LegacyCollection {
  constructor(seed = []) {
    this.rows = new Map();
    for (const row of seed) {
      this.rows.set(`${row.kind}:${row.date}`, { ...row });
    }
  }

  async findOne(query) {
    return this.rows.get(`${query.kind}:${query.date}`) || null;
  }
}

describe("PortfolioGovernor", () => {
  const baseEnv = {
    PORTFOLIO_GOVERNOR_ENABLED: "true",
    DAILY_MAX_LOSS_R: 3,
    DAILY_MAX_LOSS_INR: 0,
    MAX_LOSS_STREAK: 3,
    MAX_TRADES_PER_DAY: 6,
    MAX_OPEN_RISK_R: 1.5,
    ORDER_ERR_BREAKER_ENABLED: "true",
    ORDER_ERR_BREAKER_MAX: 5,
    ORDER_ERR_BREAKER_WINDOW_SEC: 600,
    ORDER_ERR_BREAKER_COOLDOWN_SEC: 900,
    BASE_R_INR_FALLBACK: 1000,
    CANDLE_TZ: "Asia/Kolkata",
  };

  function build({ env = {}, nowMs = 1_700_000_000_000, seed = [], legacySeed = [] } = {}) {
    const collection = new UniqueDateCollection(seed);
    const legacyCollection = new LegacyCollection(legacySeed);
    const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const gov = new PortfolioGovernor({
      envCfg: { ...baseEnv, ...env },
      collection,
      legacyCollection,
      nowMs: () => nowMs,
      sessionResolver: () => ({ dayKey: "2025-01-15" }),
      baseRInrResolver: () => 1000,
      logger,
    });
    return { gov, collection, legacyCollection, logger };
  }

  test("daily loss R triggers after losses", async () => {
    const { gov } = build();
    await gov.init();
    await gov.registerTradeClose({ tradeId: "t1", pnlInr: -1200, riskInr: 1000 });
    await gov.registerTradeClose({ tradeId: "t2", pnlInr: -1000, riskInr: 1000 });
    await gov.registerTradeClose({ tradeId: "t3", pnlInr: -900, riskInr: 1000 });

    const gate = await gov.canOpenNewTrade();
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe("daily_max_loss_r");
  });

  test("imports legacy state once, then persists only in portfolio_governor_state", async () => {
    const legacySeed = [
      {
        kind: "portfolio_governor",
        date: "2025-01-15",
        realizedPnlInr: -250,
        realizedPnlR: -0.25,
        tradesCount: 1,
        lossStreak: 1,
      },
    ];
    const { gov, collection, logger } = build({ legacySeed });
    await gov.init();

    const row = await collection.findOne({ date: "2025-01-15" });
    expect(row).toBeTruthy();
    expect(row.kind).toBeUndefined();
    expect(row.realizedPnlInr).toBe(-250);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ imported: true, source: "risk_state" }),
      "[portfolio_governor] imported legacy state",
    );
  });

  test("persistence survives restart and continues incrementing same day", async () => {
    const { gov, collection } = build();
    await gov.init();
    await gov.registerTradeClose({ tradeId: "x1", pnlInr: -100, riskInr: 1000 });

    const gov2 = new PortfolioGovernor({
      envCfg: { ...baseEnv },
      collection,
      nowMs: () => 1_700_000_000_000,
      sessionResolver: () => ({ dayKey: "2025-01-15" }),
      baseRInrResolver: () => 1000,
      logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });

    await gov2.init();
    await gov2.registerTradeClose({ tradeId: "x2", pnlInr: -100, riskInr: 1000 });
    const gate = await gov2.canOpenNewTrade();
    expect(gate.ok).toBe(true);
    expect(gov2.state.tradesCount).toBe(2);
  });

  test("write path does not touch legacy collection with unique date collisions", async () => {
    const legacyWriteCollision = new UniqueDateCollection([], { throwOnDateWrite: true });
    const { gov } = build();
    gov.legacyCollection = legacyWriteCollision;

    await expect(gov.init()).resolves.toBeUndefined();
    await expect(gov.registerTradeOpen({ tradeId: "o1", riskInr: 300 })).resolves.toBeUndefined();
  });

  test("persist strips createdAt and _id from $set after loading existing row", async () => {
    const seed = [
      {
        _id: "mongo-id-1",
        date: "2025-01-15",
        createdAt: new Date("2025-01-15T09:00:00.000Z"),
        realizedPnlInr: 10,
      },
    ];
    const { gov, collection } = build({ seed });

    await expect(gov.init()).resolves.toBeUndefined();
    await expect(gov.canOpenNewTrade()).resolves.toEqual({ ok: true });

    const row = await collection.findOne({ date: "2025-01-15" });
    expect(row).toBeTruthy();
    expect(row.createdAt).toBeDefined();

    const lastCall = collection.updateCalls.at(-1);
    expect(lastCall).toBeTruthy();
    expect(lastCall.update.$set.createdAt).toBeUndefined();
    expect(lastCall.update.$set._id).toBeUndefined();
  });

  test("DAILY_MAX_LOSS_INR ignored when R cap exists", async () => {
    const { gov } = build({ env: { DAILY_MAX_LOSS_R: 2, DAILY_MAX_LOSS_INR: 1 } });
    await gov.init();
    gov.state.realizedPnlInr = -10;
    gov.state.realizedPnlR = -0.5;
    const gate = await gov.canOpenNewTrade();
    expect(gate.ok).toBe(true);
  });

  test("MAX_OPEN_RISK_R uses openRiskInr/baseRInr conversion", async () => {
    const { gov } = build({ env: { MAX_OPEN_RISK_R: 1.2 } });
    await gov.init();
    const gate = await gov.canOpenNewTrade({ openRiskInr: 1300 });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe("max_open_risk");
  });

  test("DAILY_PROFIT_GOAL_R denies new entries when reached", async () => {
    const { gov } = build({ env: { DAILY_PROFIT_GOAL_R: 1.0 } });
    await gov.init();
    gov.state.realizedPnlR = 1.1;
    const gate = await gov.canOpenNewTrade();
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe("daily_profit_goal_r");
  });

});
