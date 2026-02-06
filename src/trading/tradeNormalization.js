function normalizeActiveTrade(activeTrade) {
  if (!activeTrade) return null;
  const instrument = activeTrade.instrument || {};
  const instrument_token =
    activeTrade.instrument_token ??
    activeTrade.instrumentToken ??
    instrument.instrument_token ??
    null;
  const tradingsymbol =
    instrument.tradingsymbol ??
    activeTrade.tradingsymbol ??
    activeTrade.symbol ??
    null;
  const timeStopAt =
    activeTrade.timeStopAt ??
    activeTrade.timeStopAtMs ??
    activeTrade.timeStopAtTs ??
    activeTrade.timeStopAtIso ??
    activeTrade.timeStopMs ??
    null;

  return {
    ...activeTrade,
    instrument_token,
    instrument: {
      ...instrument,
      tradingsymbol,
    },
    side: activeTrade.side ?? activeTrade.transaction_type ?? null,
    entryPrice: activeTrade.entryPrice ?? activeTrade.entry_price ?? null,
    stopLoss: activeTrade.stopLoss ?? activeTrade.stop_loss ?? null,
    targetPrice: activeTrade.targetPrice ?? activeTrade.target_price ?? null,
    slTrigger: activeTrade.slTrigger ?? activeTrade.sl_trigger ?? null,
    minGreenInr: activeTrade.minGreenInr ?? activeTrade.min_green_inr ?? null,
    minGreenPts: activeTrade.minGreenPts ?? activeTrade.min_green_pts ?? null,
    beLocked: activeTrade.beLocked ?? activeTrade.be_locked ?? null,
    peakLtp: activeTrade.peakLtp ?? activeTrade.peak_ltp ?? null,
    trailSl: activeTrade.trailSl ?? activeTrade.trail_sl ?? null,
    timeStopAt,
    exitReason: activeTrade.exitReason ?? activeTrade.exit_reason ?? null,
  };
}

function normalizeTradeRow(row) {
  if (!row) return row;
  const instrument = row.instrument || {};
  const instrument_token =
    row.instrument_token ?? row.instrumentToken ?? instrument.instrument_token ?? null;
  const tradingsymbol =
    instrument.tradingsymbol ?? row.tradingsymbol ?? row.symbol ?? null;
  const exchange = instrument.exchange ?? row.exchange ?? null;
  const segment = instrument.segment ?? row.segment ?? null;
  const regimeValue =
    row.regime ?? row.marketRegime ?? row.regimeLabel ?? row.regime_state ?? null;
  const premiumValue =
    row.premium ?? row.entryPremium ?? row.entry_premium ?? null;
  const entrySlippageValue =
    row.entrySlippage ?? row.slippageEntry ?? row.slippage_entry ?? null;
  const exitSlippageValue =
    row.exitSlippage ?? row.slippageExit ?? row.slippage_exit ?? null;
  const totalSlippageValue =
    row.slippage ??
    row.totalSlippage ??
    row.slippageTotal ??
    null;
  const entrySpreadValue =
    row.entrySpread ?? row.spreadAtEntry ?? row.entry_spread ?? null;
  const maeValue =
    row.mae ?? row.MAE ?? row.maxAdverseExcursion ?? row.max_adverse_excursion ?? null;
  const mfeValue =
    row.mfe ?? row.MFE ?? row.maxFavorableExcursion ?? row.max_favorable_excursion ?? null;
  const timeStopAt =
    row.timeStopAt ??
    row.time_stop_at ??
    row.timeStopAtMs ??
    row.timeStopAtTs ??
    row.timeStopAtIso ??
    row.timeStopMs ??
    null;

  return {
    ...row,
    tradeId: row.tradeId ?? row.trade_id ?? row._id ?? null,
    strategyId: row.strategyId ?? row.strategy_id ?? null,
    instrument_token,
    instrument: {
      ...instrument,
      tradingsymbol,
      exchange,
      segment,
    },
    side: row.side ?? row.transaction_type ?? null,
    qty: row.qty ?? row.quantity ?? null,
    entryPrice: row.entryPrice ?? row.entry_price ?? null,
    exitPrice: row.exitPrice ?? row.exit_price ?? null,
    stopLoss: row.stopLoss ?? row.stop_loss ?? null,
    targetPrice: row.targetPrice ?? row.target_price ?? null,
    tp1Price: row.tp1Price ?? row.tp1_price ?? null,
    slTrigger: row.slTrigger ?? row.sl_trigger ?? null,
    minGreenInr: row.minGreenInr ?? row.min_green_inr ?? null,
    minGreenPts: row.minGreenPts ?? row.min_green_pts ?? null,
    beLocked: row.beLocked ?? row.be_locked ?? null,
    peakLtp: row.peakLtp ?? row.peak_ltp ?? null,
    trailSl: row.trailSl ?? row.trail_sl ?? null,
    timeStopAt,
    status: row.status ?? null,
    closeReason: row.closeReason ?? row.close_reason ?? null,
    exitReason: row.exitReason ?? row.exit_reason ?? null,
    createdAt: row.createdAt ?? row.created_at ?? null,
    updatedAt: row.updatedAt ?? row.updated_at ?? null,
    regime: row.regime ?? regimeValue,
    marketRegime: row.marketRegime ?? regimeValue,
    regimeLabel: row.regimeLabel ?? regimeValue,
    regime_state: row.regime_state ?? regimeValue,
    premium: row.premium ?? premiumValue,
    entryPremium: row.entryPremium ?? premiumValue,
    entry_premium: row.entry_premium ?? premiumValue,
    entrySlippage: row.entrySlippage ?? entrySlippageValue,
    slippageEntry: row.slippageEntry ?? entrySlippageValue,
    slippage_entry: row.slippage_entry ?? entrySlippageValue,
    exitSlippage: row.exitSlippage ?? exitSlippageValue,
    slippageExit: row.slippageExit ?? exitSlippageValue,
    slippage_exit: row.slippage_exit ?? exitSlippageValue,
    slippage: row.slippage ?? totalSlippageValue,
    totalSlippage: row.totalSlippage ?? totalSlippageValue,
    slippageTotal: row.slippageTotal ?? totalSlippageValue,
    entrySpread: row.entrySpread ?? entrySpreadValue,
    spreadAtEntry: row.spreadAtEntry ?? entrySpreadValue,
    entry_spread: row.entry_spread ?? entrySpreadValue,
    spread: row.spread ?? entrySpreadValue,
    mae: row.mae ?? maeValue,
    MAE: row.MAE ?? maeValue,
    maxAdverseExcursion: row.maxAdverseExcursion ?? maeValue,
    max_adverse_excursion: row.max_adverse_excursion ?? maeValue,
    mfe: row.mfe ?? mfeValue,
    MFE: row.MFE ?? mfeValue,
    maxFavorableExcursion: row.maxFavorableExcursion ?? mfeValue,
    max_favorable_excursion: row.max_favorable_excursion ?? mfeValue,
  };
}

module.exports = { normalizeActiveTrade, normalizeTradeRow };
