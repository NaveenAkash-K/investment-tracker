import assert from "node:assert/strict";
import test from "node:test";
import {
    calculateMonthlyPerformance,
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
});

test("calculates the contribution required to reach a target without selling", () => {
    assert.equal(contributionNeededWithoutSelling(10000, 100000, 20), 12500);
    assert.equal(contributionNeededWithoutSelling(30000, 100000, 20), 0);
});

test("formats dates in India time instead of UTC", () => {
    const utcEvening = new Date("2026-07-19T19:30:00.000Z");
    assert.equal(getIndiaDate(utcEvening), "2026-07-20");
});
