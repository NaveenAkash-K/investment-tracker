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
