export type SwingTradeMetricInput = {
    status: "open" | "exit_pending" | "closed";
    entryPrice: number;
    quantity: number;
    currentStop: number;
    realizedPnlInr?: number | null;
    realizedRMultiple?: number | null;
    exitDate?: string | null;
};

export type SwingPerformanceMetrics = {
    closedTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRatePercentage: number | null;
    totalRealizedPnlInr: number;
    averageRMultiple: number | null;
    profitFactor: number | null;
    maximumDrawdownInr: number;
    openRiskInr: number;
    openCapitalInr: number;
};

export type SwingExecutionInput = {
    tradeId: string;
    signalEntry: number;
    maximumEntry: number;
    entryPrice: number;
    initialStop: number;
    quantity: number;
    plannedRiskInr: number;
    feesInr: number;
    exitPrice?: number | null;
    exitSignalPrice?: number | null;
    exitSignalStop?: number | null;
};

export type SwingExecutionRow = {
    tradeId: string;
    entrySlippageInr: number;
    entrySlippagePercentage: number | null;
    maximumEntryRoomUsedPercentage: number | null;
    actualInitialRiskInr: number;
    riskVarianceInr: number;
    feesInR: number | null;
    exitSlippageInr: number | null;
    stopGapInr: number | null;
};

export type SwingExecutionSummary = {
    rows: SwingExecutionRow[];
    totalEntrySlippageInr: number;
    totalExitSlippageInr: number;
    totalFeesInr: number;
    totalRiskVarianceInr: number;
    totalStopGapInr: number;
    comparableExitCount: number;
};

function finiteNonNegative(value: number) {
    return Number.isFinite(value) && value >= 0;
}

export function calculateSwingQuantity({
    tradingCapitalInr,
    riskPerTradePercentage,
    entryPrice,
    initialStop,
    maxOpenPositions,
}: {
    tradingCapitalInr: number;
    riskPerTradePercentage: number;
    entryPrice: number;
    initialStop: number;
    maxOpenPositions: number;
}) {
    if (
        !finiteNonNegative(tradingCapitalInr) ||
        !Number.isFinite(riskPerTradePercentage) || riskPerTradePercentage <= 0 ||
        !Number.isFinite(entryPrice) || entryPrice <= 0 ||
        !Number.isFinite(initialStop) || initialStop <= 0 || initialStop >= entryPrice ||
        !Number.isInteger(maxOpenPositions) || maxOpenPositions <= 0
    ) return 0;

    const riskBudget = tradingCapitalInr * riskPerTradePercentage / 100;
    const riskPerShare = entryPrice - initialStop;
    const riskQuantity = Math.floor(riskBudget / riskPerShare);
    const notionalSlot = tradingCapitalInr / maxOpenPositions;
    const notionalQuantity = Math.floor(notionalSlot / entryPrice);
    return Math.max(Math.min(riskQuantity, notionalQuantity), 0);
}

export function calculateSwingPerformance(
    trades: SwingTradeMetricInput[]
): SwingPerformanceMetrics {
    const closed = trades
        .filter((trade) => trade.status === "closed" && trade.realizedPnlInr !== null && trade.realizedPnlInr !== undefined)
        .sort((left, right) => (left.exitDate ?? "").localeCompare(right.exitDate ?? ""));
    const open = trades.filter((trade) => trade.status !== "closed");
    const wins = closed.filter((trade) => (trade.realizedPnlInr ?? 0) > 0);
    const losses = closed.filter((trade) => (trade.realizedPnlInr ?? 0) < 0);
    const grossProfit = wins.reduce((sum, trade) => sum + (trade.realizedPnlInr ?? 0), 0);
    const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + (trade.realizedPnlInr ?? 0), 0));
    const rValues = closed
        .map((trade) => trade.realizedRMultiple)
        .filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));

    let equity = 0;
    let peak = 0;
    let maximumDrawdownInr = 0;
    for (const trade of closed) {
        equity += trade.realizedPnlInr ?? 0;
        peak = Math.max(peak, equity);
        maximumDrawdownInr = Math.max(maximumDrawdownInr, peak - equity);
    }

    return {
        closedTrades: closed.length,
        winningTrades: wins.length,
        losingTrades: losses.length,
        winRatePercentage: closed.length > 0 ? wins.length / closed.length * 100 : null,
        totalRealizedPnlInr: closed.reduce((sum, trade) => sum + (trade.realizedPnlInr ?? 0), 0),
        averageRMultiple: rValues.length > 0 ? rValues.reduce((sum, value) => sum + value, 0) / rValues.length : null,
        profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : null,
        maximumDrawdownInr,
        openRiskInr: open.reduce(
            (sum, trade) => sum + Math.max(trade.entryPrice - trade.currentStop, 0) * trade.quantity,
            0
        ),
        openCapitalInr: open.reduce((sum, trade) => sum + trade.entryPrice * trade.quantity, 0),
    };
}

export function calculateSwingExecutionQuality(
    trades: SwingExecutionInput[]
): SwingExecutionSummary {
    const rows = trades.map((trade): SwingExecutionRow => {
        const actualRisk = Math.max(trade.entryPrice - trade.initialStop, 0) * trade.quantity;
        const entrySlippagePerShare = trade.entryPrice - trade.signalEntry;
        const entryRange = trade.maximumEntry - trade.signalEntry;
        const exitSlippage = trade.exitPrice !== null
            && trade.exitPrice !== undefined
            && trade.exitSignalPrice !== null
            && trade.exitSignalPrice !== undefined
            ? (trade.exitSignalPrice - trade.exitPrice) * trade.quantity
            : null;
        const stopGap = trade.exitPrice !== null
            && trade.exitPrice !== undefined
            && trade.exitSignalStop !== null
            && trade.exitSignalStop !== undefined
            ? Math.max(trade.exitSignalStop - trade.exitPrice, 0) * trade.quantity
            : null;
        return {
            tradeId: trade.tradeId,
            entrySlippageInr: entrySlippagePerShare * trade.quantity,
            entrySlippagePercentage: trade.signalEntry > 0
                ? entrySlippagePerShare / trade.signalEntry * 100
                : null,
            maximumEntryRoomUsedPercentage: entryRange > 0
                ? entrySlippagePerShare / entryRange * 100
                : null,
            actualInitialRiskInr: actualRisk,
            riskVarianceInr: actualRisk - trade.plannedRiskInr,
            feesInR: actualRisk > 0 ? trade.feesInr / actualRisk : null,
            exitSlippageInr: exitSlippage,
            stopGapInr: stopGap,
        };
    });
    return {
        rows,
        totalEntrySlippageInr: rows.reduce((sum, row) => sum + row.entrySlippageInr, 0),
        totalExitSlippageInr: rows.reduce((sum, row) => sum + (row.exitSlippageInr ?? 0), 0),
        totalFeesInr: trades.reduce((sum, trade) => sum + trade.feesInr, 0),
        totalRiskVarianceInr: rows.reduce((sum, row) => sum + row.riskVarianceInr, 0),
        totalStopGapInr: rows.reduce((sum, row) => sum + (row.stopGapInr ?? 0), 0),
        comparableExitCount: rows.filter((row) => row.exitSlippageInr !== null).length,
    };
}
