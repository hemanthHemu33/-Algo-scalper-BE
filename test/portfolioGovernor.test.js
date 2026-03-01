const { PortfolioGovernor } = require("../src/risk/portfolioGovernor");

class MockCollection {
  constructor(seed = []) {
    this.rows = new Map();
    for (const row of seed) {
      this.rows.set(`${row.kind}:${row.date}`, { ...row });
    }
  }

  async findOne(query) {
    return this.rows.get(`${query.kind}:${query.date}`) || null;
  }

  async updateOne(filter, update) {
    const key = `${filter.kind}:${filter.date}`;
    const prev = this.rows.get(key) || {};
    const next = {
      ...prev,
      ...(update.$setOnInsert || {}),
      ...(update.$set || {}),
    };
    this.rows.set(key, next);
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

  function build({ env = {}, nowMs = 1_700_000_000_000, seed = [] } = {}) {
    const collection = new MockCollection(seed);
    const gov = new PortfolioGovernor({
      envCfg: { ...baseEnv, ...env },
      collection,
      nowMs: () => nowMs,
      sessionResolver: () => ({ dayKey: "2025-01-15" }),
      baseRInrResolver: () => 1000,
      logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
    });
    return { gov, collection };
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

  test("loss streak triggers after 3 consecutive losses", async () => {
    const { gov } = build({ env: { DAILY_MAX_LOSS_R: 99 } });
    await gov.init();
    await gov.registerTradeClose({ tradeId: "l1", pnlInr: -100, riskInr: 1000 });
    await gov.registerTradeClose({ tradeId: "l2", pnlInr: -120, riskInr: 1000 });
    await gov.registerTradeClose({ tradeId: "l3", pnlInr: -80, riskInr: 1000 });

    const gate = await gov.canOpenNewTrade();
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe("loss_streak");
  });

  test("max trades per day triggers", async () => {
    const { gov } = build({ env: { MAX_TRADES_PER_DAY: 2, DAILY_MAX_LOSS_R: 99 } });
    await gov.init();
    await gov.registerTradeClose({ tradeId: "a", pnlInr: 50, riskInr: 1000 });
    await gov.registerTradeClose({ tradeId: "b", pnlInr: 20, riskInr: 1000 });

    const gate = await gov.canOpenNewTrade();
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe("max_trades");
  });

  test("max open risk triggers with open positions", async () => {
    const { gov } = build();
    await gov.init();
    await gov.registerTradeOpen({ tradeId: "o1", riskInr: 1000 });
    await gov.registerTradeOpen({ tradeId: "o2", riskInr: 600 });

    const gate = await gov.canOpenNewTrade();
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe("max_open_risk");
  });

  test("persistence loads same-day state from DB and dedupes close", async () => {
    const seed = [
      {
        kind: "portfolio_governor",
        date: "2025-01-15",
        realizedPnlInr: -250,
        realizedPnlR: -0.25,
        tradesCount: 1,
        lossStreak: 1,
        openRiskInr: 500,
        openTradeRiskInrById: { x1: 500 },
        processedClosedTradeIds: ["x0"],
      },
    ];
    const { gov } = build({ seed });
    await gov.init();

    await gov.registerTradeClose({ tradeId: "x0", pnlInr: -100, riskInr: 1000 });
    const gate1 = await gov.canOpenNewTrade();
    expect(gate1.ok).toBe(true);

    await gov.registerTradeClose({ tradeId: "x2", pnlInr: -150, riskInr: 1000 });
    const gate2 = await gov.canOpenNewTrade();
    expect(gate2.ok).toBe(true);
  });
});
