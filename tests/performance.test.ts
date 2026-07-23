import assert from "node:assert/strict";
import test from "node:test";
import {
    buildMonthlyPortfolioReturns,
    calculateContributionAdjustedReturn,
    calculateLinkedReturn,
    calculateMonthlyPerformance,
    calculateNewMoneyAllocation,
    contributionNeededWithoutSelling,
    getIndiaDate,
} from "../lib/performance.ts";

test("separates USD market growth from currency appreciation", () => {
    const result = calculateMonthlyPerformance({
        trackingCurrency: "USD",
        hasPreviousMonth: true,
        openingNativeValue: 5000,
        openingFxRate: 85,
        contributionInr: 86000,
        contributionNative: 1000,
        contributionFxRate: 86,
        closingNativeValue: 6200,
        closingFxRate: 87,
    });

    assert.equal(result.marketGainNative, 200);
    assert.equal(result.marketGainInr, 17400);
    assert.equal(result.currencyGainInr, 11000);
    assert.equal(result.combinedGainInr, 28400);
    assert.equal(result.closingValueInr, 539400);
    assert.equal(result.reconciledClosingValueInr, result.closingValueInr);
    assert.equal(result.capitalBaseInr, 511000);
    assert.equal(result.combinedReturnPercentage, (28400 / 511000) * 100);
});

test("tracks INR growth without a currency component", () => {
    const result = calculateMonthlyPerformance({
        trackingCurrency: "INR",
        hasPreviousMonth: true,
        openingNativeValue: 1000000,
        openingFxRate: 1,
        contributionInr: 40000,
        contributionFxRate: 1,
        closingNativeValue: 1070000,
        closingFxRate: 1,
    });

    assert.equal(result.marketGainInr, 30000);
    assert.equal(result.currencyGainInr, 0);
    assert.equal(result.combinedGainInr, 30000);
    assert.equal(result.reconciledClosingValueInr, 1070000);
    assert.equal(result.combinedReturnPercentage, (30000 / 1040000) * 100);
});

test("uses the first enhanced month as a zero-growth baseline", () => {
    const result = calculateMonthlyPerformance({
        trackingCurrency: "USD",
        hasPreviousMonth: false,
        openingNativeValue: 0,
        openingFxRate: 86,
        contributionInr: 10000,
        contributionFxRate: 86,
        closingNativeValue: 500,
        closingFxRate: 87,
    });

    assert.equal(result.isBaseline, true);
    assert.equal(result.marketGainInr, 0);
    assert.equal(result.currencyGainInr, 0);
    assert.equal(result.closingValueInr, 43500);
    assert.equal(result.combinedReturnPercentage, null);
});

test("allocates new money only toward post-contribution target shortfalls", () => {
    const result = calculateNewMoneyAllocation([
        { categoryId: "india", categoryName: "Indian Assets", currentAmount: 233434.47, targetPercentage: 60, plannedAmount: 25000 },
        { categoryId: "global", categoryName: "Global Assets", currentAmount: 49868.73, targetPercentage: 20, plannedAmount: 10000 },
        { categoryId: "gold", categoryName: "Gold & Silver", currentAmount: 32796.47, targetPercentage: 10, plannedAmount: 3000 },
        { categoryId: "crypto", categoryName: "Crypto", currentAmount: 10964, targetPercentage: 5, plannedAmount: 2000 },
        { categoryId: "debt", categoryName: "Debt", currentAmount: 11366.86, targetPercentage: 5, plannedAmount: 0 },
    ], 40000);

    assert.equal(result.rows.find((row) => row.categoryId === "india")?.suggestedAmount, 0);
    assert.ok(
        (result.rows.find((row) => row.categoryId === "global")?.suggestedAmount ?? 0) >
        (result.rows.find((row) => row.categoryId === "gold")?.suggestedAmount ?? 0)
    );
    assert.equal(result.rows.reduce((sum, row) => sum + row.suggestedAmount, 0), 40000);
});

test("uses target weights when a portfolio starts from zero", () => {
    const result = calculateNewMoneyAllocation([
        { categoryId: "equity", categoryName: "Equity", currentAmount: 0, targetPercentage: 75 },
        { categoryId: "debt", categoryName: "Debt", currentAmount: 0, targetPercentage: 25 },
    ], 10000);

    assert.deepEqual(result.rows.map((row) => row.suggestedAmount), [7500, 2500]);
    assert.deepEqual(result.rows.map((row) => row.projectedPercentage), [75, 25]);
});

test("calculates a portfolio return on opening capital plus start-of-month contributions", () => {
    const result = calculateContributionAdjustedReturn([
        {
            performanceMonth: "2026-07-01",
            isBaseline: false,
            openingValueInr: 100000,
            contributionInr: 10000,
            marketGainInr: 3300,
            currencyGainInr: 1100,
            combinedGainInr: 4400,
        },
        {
            performanceMonth: "2026-07-01",
            isBaseline: true,
            openingValueInr: 50000,
            contributionInr: 5000,
            marketGainInr: 0,
            currencyGainInr: 0,
            combinedGainInr: 0,
        },
    ]);

    assert.equal(result.capitalBaseInr, 110000);
    assert.equal(result.marketReturnPercentage, 3);
    assert.equal(result.currencyReturnPercentage, 1);
    assert.equal(result.combinedReturnPercentage, 4);
    assert.equal(result.contributionInr, 15000);
    assert.equal(result.trackedRows, 1);
    assert.equal(result.baselineRows, 1);
});

test("links only consecutive contribution-adjusted monthly returns", () => {
    const rows = [
        ["2026-04-01", 1],
        ["2026-05-01", 2],
        ["2026-06-01", -1],
    ].map(([performanceMonth, returnPercentage]) => ({
        performanceMonth: String(performanceMonth),
        isBaseline: false,
        openingValueInr: 100,
        contributionInr: 0,
        marketGainInr: Number(returnPercentage),
        currencyGainInr: 0,
        combinedGainInr: Number(returnPercentage),
    }));
    const monthly = buildMonthlyPortfolioReturns(rows);

    assert.ok(Math.abs((calculateLinkedReturn(monthly, 3) ?? 0) - 1.9898) < 0.000001);
    assert.equal(calculateLinkedReturn(monthly, 6), null);

    monthly[1].performanceMonth = "2026-08-01";
    monthly.sort((left, right) => left.performanceMonth.localeCompare(right.performanceMonth));
    assert.equal(calculateLinkedReturn(monthly, 3), null);
});

test("does not label a multi-month review interval as a monthly linked return", () => {
    const rows = buildMonthlyPortfolioReturns([
        {
            performanceMonth: "2026-06-01",
            periodMonths: 1,
            isBaseline: false,
            openingValueInr: 100,
            contributionInr: 0,
            marketGainInr: 10,
            currencyGainInr: 0,
            combinedGainInr: 10,
        },
        {
            performanceMonth: "2026-07-01",
            periodMonths: 2,
            isBaseline: false,
            openingValueInr: 110,
            contributionInr: 0,
            marketGainInr: 11,
            currencyGainInr: 0,
            combinedGainInr: 11,
        },
    ]);

    assert.equal(rows[1].intervalMonths, 2);
    assert.equal(calculateLinkedReturn(rows, 2), null);
});

test("calculates the contribution required to reach a target without selling", () => {
    assert.equal(contributionNeededWithoutSelling(10000, 100000, 20), 12500);
    assert.equal(contributionNeededWithoutSelling(30000, 100000, 20), 0);
});

test("formats dates in India time instead of UTC", () => {
    const utcEvening = new Date("2026-07-19T19:30:00.000Z");
    assert.equal(getIndiaDate(utcEvening), "2026-07-20");
});
