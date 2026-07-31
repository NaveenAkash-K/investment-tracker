import assert from "node:assert/strict";
import test from "node:test";
import { calculateAllocationOutcome, calculateAverageRecommendationTurnover, summarizeTradesByRegime } from "../lib/strategy-scorecard.ts";

test("calculates normalized monthly recommendation turnover", () => {
    const turnover = calculateAverageRecommendationTurnover([
        { month: "2026-06", weightsByKey: { india: 60, global: 40 } },
        { month: "2026-07", weightsByKey: { india: 50, global: 50 } },
    ]);
    assert.ok(turnover !== null && Math.abs(turnover - 10) < 1e-9);
});

test("compares target-only and signal-adjusted contribution outcomes", () => {
    const result = calculateAllocationOutcome([
        { category: "India", targetOnlyAmount: 5000, suggestedAmount: 4000, combinedReturnPercentage: 2 },
        { category: "Global", targetOnlyAmount: 5000, suggestedAmount: 6000, combinedReturnPercentage: 4 },
    ]);
    assert.equal(result.targetOnlyReturnPercentage, 3);
    assert.equal(result.signalAdjustedReturnPercentage, 3.2);
});

test("summarizes closed swing outcomes by entry regime", () => {
    const rows = summarizeTradesByRegime([
        { regime: "AMBER", realizedPnlInr: 100, realizedRMultiple: 1 },
        { regime: "AMBER", realizedPnlInr: -50, realizedRMultiple: -0.5 },
    ]);
    assert.equal(rows[0].trades, 2);
    assert.equal(rows[0].winRatePercentage, 50);
    assert.equal(rows[0].averageRMultiple, 0.25);
});
