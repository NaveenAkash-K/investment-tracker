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
    marketGainNative: number;
    marketGainInr: number;
    currencyGainInr: number;
    combinedGainInr: number;
    reconciledClosingValueInr: number;
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
            marketGainNative: 0,
            marketGainInr: 0,
            currencyGainInr: 0,
            combinedGainInr: 0,
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

    return {
        isBaseline: false,
        contributionNative,
        openingValueInr,
        closingValueInr,
        marketGainNative,
        marketGainInr,
        currencyGainInr,
        combinedGainInr,
        reconciledClosingValueInr,
    };
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
