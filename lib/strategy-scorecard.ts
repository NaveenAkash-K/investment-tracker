export type RecommendationObservation = {
    month: string;
    weightsByKey: Record<string, number>;
};

export type AllocationOutcomeInput = {
    category: string;
    targetOnlyAmount: number;
    suggestedAmount: number;
    combinedReturnPercentage: number | null;
};

export type RegimeTradeInput = {
    regime: string;
    realizedPnlInr: number;
    realizedRMultiple: number | null;
};

export function calculateAverageRecommendationTurnover(observations: RecommendationObservation[]) {
    const ordered = [...observations].sort((left, right) => left.month.localeCompare(right.month));
    if (ordered.length < 2) return null;
    const changes: number[] = [];
    for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1].weightsByKey;
        const current = ordered[index].weightsByKey;
        const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
        const previousTotal = Object.values(previous).reduce((sum, value) => sum + value, 0);
        const currentTotal = Object.values(current).reduce((sum, value) => sum + value, 0);
        if (previousTotal <= 0 || currentTotal <= 0) continue;
        const turnover = [...keys].reduce((sum, key) => {
            const previousWeight = (previous[key] ?? 0) / previousTotal;
            const currentWeight = (current[key] ?? 0) / currentTotal;
            return sum + Math.abs(currentWeight - previousWeight);
        }, 0) / 2 * 100;
        changes.push(turnover);
    }
    return changes.length ? changes.reduce((sum, value) => sum + value, 0) / changes.length : null;
}

export function calculateAllocationOutcome(rows: AllocationOutcomeInput[]) {
    const eligible = rows.filter((row) => row.combinedReturnPercentage !== null);
    const targetCapital = eligible.reduce((sum, row) => sum + row.targetOnlyAmount, 0);
    const suggestedCapital = eligible.reduce((sum, row) => sum + row.suggestedAmount, 0);
    const targetGain = eligible.reduce((sum, row) => sum + row.targetOnlyAmount * (row.combinedReturnPercentage ?? 0) / 100, 0);
    const suggestedGain = eligible.reduce((sum, row) => sum + row.suggestedAmount * (row.combinedReturnPercentage ?? 0) / 100, 0);
    return {
        eligibleCategories: eligible.length,
        targetOnlyReturnPercentage: targetCapital > 0 ? targetGain / targetCapital * 100 : null,
        signalAdjustedReturnPercentage: suggestedCapital > 0 ? suggestedGain / suggestedCapital * 100 : null,
        targetOnlyGainInr: targetGain,
        signalAdjustedGainInr: suggestedGain,
    };
}

export function summarizeTradesByRegime(trades: RegimeTradeInput[]) {
    const grouped = new Map<string, RegimeTradeInput[]>();
    for (const trade of trades) grouped.set(trade.regime, [...(grouped.get(trade.regime) ?? []), trade]);
    return [...grouped.entries()].map(([regime, rows]) => {
        const rValues = rows.map((row) => row.realizedRMultiple).filter((value): value is number => value !== null && Number.isFinite(value));
        return {
            regime,
            trades: rows.length,
            winRatePercentage: rows.filter((row) => row.realizedPnlInr > 0).length / rows.length * 100,
            totalPnlInr: rows.reduce((sum, row) => sum + row.realizedPnlInr, 0),
            averageRMultiple: rValues.length ? rValues.reduce((sum, value) => sum + value, 0) / rValues.length : null,
        };
    }).sort((left, right) => left.regime.localeCompare(right.regime));
}
