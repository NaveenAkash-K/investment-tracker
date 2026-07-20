export type TrackingCurrency = "INR" | "USD";

export type MonthlyPerformanceInput = {
    trackingCurrency: TrackingCurrency;
    hasPreviousMonth: boolean;
    openingNativeValue: number;
    openingFxRate: number;
    contributionInr: number;
    contributionNative?: number;
    contributionFxRate: number;
    closingNativeValue: number;
    closingFxRate: number;
};

export type MonthlyPerformanceResult = {
    isBaseline: boolean;
    contributionNative: number;
    openingValueInr: number;
    closingValueInr: number;
    capitalBaseInr: number;
    marketGainNative: number;
    marketGainInr: number;
    currencyGainInr: number;
    combinedGainInr: number;
    marketReturnPercentage: number | null;
    currencyReturnPercentage: number | null;
    combinedReturnPercentage: number | null;
    reconciledClosingValueInr: number;
};

export type NewMoneyAllocationInput = {
    categoryId: string;
    categoryName: string;
    currentAmount: number;
    targetPercentage: number;
    plannedAmount?: number;
};

export type NewMoneyAllocationRow = NewMoneyAllocationInput & {
    currentPercentage: number;
    shortfallAtEnd: number;
    suggestedAmount: number;
    projectedAmount: number;
    projectedPercentage: number;
    projectedDriftPercentage: number;
};

export type NewMoneyAllocationResult = {
    budget: number;
    currentTotal: number;
    projectedTotal: number;
    rows: NewMoneyAllocationRow[];
};

export type ContributionAdjustedPerformanceInput = {
    performanceMonth: string;
    isBaseline: boolean;
    openingValueInr: number;
    contributionInr: number;
    marketGainInr: number;
    currencyGainInr: number;
    combinedGainInr: number;
};

export type ContributionAdjustedReturn = {
    capitalBaseInr: number;
    contributionInr: number;
    marketGainInr: number;
    currencyGainInr: number;
    combinedGainInr: number;
    marketReturnPercentage: number | null;
    currencyReturnPercentage: number | null;
    combinedReturnPercentage: number | null;
    trackedRows: number;
    baselineRows: number;
};

export type MonthlyPortfolioReturn = ContributionAdjustedReturn & {
    performanceMonth: string;
};

function assertFiniteNonNegative(value: number, label: string) {
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${label} must be a non-negative number.`);
    }
}

function assertPositive(value: number, label: string) {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${label} must be greater than zero.`);
    }
}

export function calculateMonthlyPerformance(
    input: MonthlyPerformanceInput
): MonthlyPerformanceResult {
    assertFiniteNonNegative(input.openingNativeValue, "Opening value");
    assertFiniteNonNegative(input.contributionInr, "Contribution");
    assertFiniteNonNegative(input.closingNativeValue, "Closing value");

    const openingFxRate = input.trackingCurrency === "INR" ? 1 : input.openingFxRate;
    const contributionFxRate =
        input.trackingCurrency === "INR" ? 1 : input.contributionFxRate;
    const closingFxRate = input.trackingCurrency === "INR" ? 1 : input.closingFxRate;

    assertPositive(openingFxRate, "Opening exchange rate");
    assertPositive(contributionFxRate, "Contribution exchange rate");
    assertPositive(closingFxRate, "Closing exchange rate");

    const contributionNative =
        input.trackingCurrency === "INR"
            ? input.contributionInr
            : input.contributionNative ??
              (input.contributionInr === 0
                  ? 0
                  : input.contributionInr / contributionFxRate);

    assertFiniteNonNegative(contributionNative, "Foreign contribution");

    const closingValueInr = input.closingNativeValue * closingFxRate;

    if (!input.hasPreviousMonth) {
        return {
            isBaseline: true,
            contributionNative,
            openingValueInr: closingValueInr,
            closingValueInr,
            capitalBaseInr: 0,
            marketGainNative: 0,
            marketGainInr: 0,
            currencyGainInr: 0,
            combinedGainInr: 0,
            marketReturnPercentage: null,
            currencyReturnPercentage: null,
            combinedReturnPercentage: null,
            reconciledClosingValueInr: closingValueInr,
        };
    }

    const openingValueInr = input.openingNativeValue * openingFxRate;
    const marketGainNative =
        input.closingNativeValue - input.openingNativeValue - contributionNative;
    const marketGainInr = marketGainNative * closingFxRate;
    const currencyGainInr =
        input.trackingCurrency === "INR"
            ? 0
            : input.openingNativeValue * (closingFxRate - openingFxRate) +
              contributionNative * (closingFxRate - contributionFxRate);
    const combinedGainInr = marketGainInr + currencyGainInr;
    const reconciledClosingValueInr =
        openingValueInr + input.contributionInr + combinedGainInr;
    const capitalBaseInr = openingValueInr + input.contributionInr;

    return {
        isBaseline: false,
        contributionNative,
        openingValueInr,
        closingValueInr,
        capitalBaseInr,
        marketGainNative,
        marketGainInr,
        currencyGainInr,
        combinedGainInr,
        marketReturnPercentage: percentageOf(marketGainInr, capitalBaseInr),
        currencyReturnPercentage: percentageOf(currencyGainInr, capitalBaseInr),
        combinedReturnPercentage: percentageOf(combinedGainInr, capitalBaseInr),
        reconciledClosingValueInr,
    };
}

function percentageOf(value: number, base: number) {
    return base > 0 ? (value / base) * 100 : null;
}

function roundAllocation(total: number, weights: number[]) {
    const totalPaise = Math.round(total * 100);
    const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
    if (totalPaise === 0 || weightTotal <= 0) return weights.map(() => 0);

    const raw = weights.map((weight) => (totalPaise * weight) / weightTotal);
    const allocated = raw.map(Math.floor);
    let remaining = totalPaise - allocated.reduce((sum, value) => sum + value, 0);
    const remainderOrder = raw
        .map((value, index) => ({ index, remainder: value - allocated[index] }))
        .sort((left, right) => right.remainder - left.remainder || left.index - right.index);

    for (let index = 0; index < remainderOrder.length && remaining > 0; index += 1) {
        allocated[remainderOrder[index].index] += 1;
        remaining -= 1;
    }

    return allocated.map((value) => value / 100);
}

/**
 * Allocates a fixed contribution only to categories that will be below their
 * target after the contribution is added. When existing overweight categories
 * make the total shortfall larger than the budget, each positive shortfall is
 * funded proportionally. No selling or market-timing signal is assumed.
 */
export function calculateNewMoneyAllocation(
    inputs: NewMoneyAllocationInput[],
    budget: number
): NewMoneyAllocationResult {
    assertFiniteNonNegative(budget, "New-money budget");
    if (inputs.length === 0) throw new Error("At least one category is required.");

    for (const input of inputs) {
        assertFiniteNonNegative(input.currentAmount, `${input.categoryName} current value`);
        assertFiniteNonNegative(input.targetPercentage, `${input.categoryName} target`);
        if (input.targetPercentage > 100) {
            throw new Error(`${input.categoryName} target cannot exceed 100%.`);
        }
    }

    const targetTotal = inputs.reduce((sum, input) => sum + input.targetPercentage, 0);
    if (Math.abs(targetTotal - 100) > 0.01) {
        throw new Error(`Targets must total 100%. Current total is ${targetTotal.toFixed(2)}%.`);
    }

    const currentTotal = inputs.reduce((sum, input) => sum + input.currentAmount, 0);
    const projectedTotal = currentTotal + budget;
    const shortfalls = inputs.map((input) =>
        Math.max((projectedTotal * input.targetPercentage) / 100 - input.currentAmount, 0)
    );
    const suggestions = roundAllocation(budget, shortfalls);

    return {
        budget,
        currentTotal,
        projectedTotal,
        rows: inputs.map((input, index) => {
            const suggestedAmount = suggestions[index];
            const projectedAmount = input.currentAmount + suggestedAmount;
            const projectedPercentage =
                projectedTotal > 0 ? (projectedAmount / projectedTotal) * 100 : 0;

            return {
                ...input,
                plannedAmount: input.plannedAmount ?? 0,
                currentPercentage:
                    currentTotal > 0 ? (input.currentAmount / currentTotal) * 100 : 0,
                shortfallAtEnd: shortfalls[index],
                suggestedAmount,
                projectedAmount,
                projectedPercentage,
                projectedDriftPercentage: projectedPercentage - input.targetPercentage,
            };
        }),
    };
}

export function calculateContributionAdjustedReturn(
    rows: ContributionAdjustedPerformanceInput[]
): ContributionAdjustedReturn {
    const eligibleRows = rows.filter((row) => !row.isBaseline);
    const totalContributionInr = rows.reduce((sum, row) => {
        assertFiniteNonNegative(row.contributionInr, "Contribution");
        return sum + row.contributionInr;
    }, 0);
    const totals = eligibleRows.reduce(
        (result, row) => {
            assertFiniteNonNegative(row.openingValueInr, "Opening value");
            result.capitalBaseInr += row.openingValueInr + row.contributionInr;
            result.marketGainInr += row.marketGainInr;
            result.currencyGainInr += row.currencyGainInr;
            result.combinedGainInr += row.combinedGainInr;
            return result;
        },
        {
            capitalBaseInr: 0,
            marketGainInr: 0,
            currencyGainInr: 0,
            combinedGainInr: 0,
        }
    );

    return {
        ...totals,
        contributionInr: totalContributionInr,
        marketReturnPercentage: percentageOf(totals.marketGainInr, totals.capitalBaseInr),
        currencyReturnPercentage: percentageOf(totals.currencyGainInr, totals.capitalBaseInr),
        combinedReturnPercentage: percentageOf(totals.combinedGainInr, totals.capitalBaseInr),
        trackedRows: eligibleRows.length,
        baselineRows: rows.length - eligibleRows.length,
    };
}

export function buildMonthlyPortfolioReturns(
    rows: ContributionAdjustedPerformanceInput[]
): MonthlyPortfolioReturn[] {
    const rowsByMonth = new Map<string, ContributionAdjustedPerformanceInput[]>();
    for (const row of rows) {
        rowsByMonth.set(row.performanceMonth, [...(rowsByMonth.get(row.performanceMonth) ?? []), row]);
    }

    return Array.from(rowsByMonth.entries())
        .map(([performanceMonth, monthRows]) => ({
            performanceMonth,
            ...calculateContributionAdjustedReturn(monthRows),
        }))
        .sort((left, right) => left.performanceMonth.localeCompare(right.performanceMonth));
}

function monthIndex(value: string) {
    const [year, month] = value.slice(0, 7).split("-").map(Number);
    return year * 12 + month - 1;
}

/** Links consecutive contribution-adjusted monthly returns into a rolling return. */
export function calculateLinkedReturn(
    monthlyReturns: MonthlyPortfolioReturn[],
    windowSize: number
) {
    if (!Number.isInteger(windowSize) || windowSize <= 0) return null;
    const eligible = monthlyReturns.filter(
        (row) => row.combinedReturnPercentage !== null && row.baselineRows === 0
    );
    if (eligible.length < windowSize) return null;

    const window = eligible.slice(-windowSize);
    for (let index = 1; index < window.length; index += 1) {
        if (monthIndex(window[index].performanceMonth) - monthIndex(window[index - 1].performanceMonth) !== 1) {
            return null;
        }
    }

    return (
        window.reduce(
            (growth, row) => growth * (1 + (row.combinedReturnPercentage ?? 0) / 100),
            1
        ) - 1
    ) * 100;
}

export function contributionNeededWithoutSelling(
    currentCategoryAmount: number,
    totalPortfolioValue: number,
    targetPercentage: number
): number {
    if (
        currentCategoryAmount < 0 ||
        totalPortfolioValue < 0 ||
        targetPercentage <= 0 ||
        targetPercentage >= 100
    ) {
        return 0;
    }

    const target = targetPercentage / 100;
    const required =
        (target * totalPortfolioValue - currentCategoryAmount) / (1 - target);

    return Math.max(required, 0);
}

export function getIndiaDateParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);

    const valueByType = new Map(parts.map((part) => [part.type, part.value]));

    return {
        year: valueByType.get("year") ?? "1970",
        month: valueByType.get("month") ?? "01",
        day: valueByType.get("day") ?? "01",
    };
}

export function getIndiaDate(date = new Date()) {
    const parts = getIndiaDateParts(date);
    return `${parts.year}-${parts.month}-${parts.day}`;
}

export function getIndiaMonthStart(date = new Date()) {
    const parts = getIndiaDateParts(date);
    return `${parts.year}-${parts.month}-01`;
}
