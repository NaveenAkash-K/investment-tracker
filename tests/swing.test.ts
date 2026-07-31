import assert from "node:assert/strict";
import test from "node:test";
import { calculateSwingExecutionQuality, calculateSwingPerformance, calculateSwingQuantity } from "../lib/swing.ts";

test("sizes a swing position by both risk and capital slot", () => {
    assert.equal(calculateSwingQuantity({
        tradingCapitalInr: 100000,
        riskPerTradePercentage: 1,
        entryPrice: 500,
        initialStop: 475,
        maxOpenPositions: 5,
    }), 40);

    assert.equal(calculateSwingQuantity({
        tradingCapitalInr: 100000,
        riskPerTradePercentage: 2,
        entryPrice: 5000,
        initialStop: 4900,
        maxOpenPositions: 5,
    }), 4);
});

test("rejects invalid position-size inputs", () => {
    assert.equal(calculateSwingQuantity({
        tradingCapitalInr: 100000,
        riskPerTradePercentage: 1,
        entryPrice: 500,
        initialStop: 510,
        maxOpenPositions: 5,
    }), 0);
});

test("calculates swing journal performance and remaining open risk", () => {
    const metrics = calculateSwingPerformance([
        { status: "closed", entryPrice: 100, quantity: 10, currentStop: 95, realizedPnlInr: 200, realizedRMultiple: 2, exitDate: "2026-05-01" },
        { status: "closed", entryPrice: 100, quantity: 10, currentStop: 95, realizedPnlInr: -100, realizedRMultiple: -1, exitDate: "2026-06-01" },
        { status: "open", entryPrice: 200, quantity: 5, currentStop: 190 },
    ]);

    assert.equal(metrics.closedTrades, 2);
    assert.equal(metrics.winRatePercentage, 50);
    assert.equal(metrics.totalRealizedPnlInr, 100);
    assert.equal(metrics.averageRMultiple, 0.5);
    assert.equal(metrics.profitFactor, 2);
    assert.equal(metrics.maximumDrawdownInr, 100);
    assert.equal(metrics.openRiskInr, 50);
    assert.equal(metrics.openCapitalInr, 1000);
});

test("calculates execution quality only from stored fills and exit signals", () => {
    const result = calculateSwingExecutionQuality([{
        tradeId: "trade-1",
        signalEntry: 100,
        maximumEntry: 105,
        entryPrice: 102,
        initialStop: 95,
        quantity: 10,
        plannedRiskInr: 50,
        feesInr: 7,
        exitSignalPrice: 112,
        exitSignalStop: 110,
        exitPrice: 109,
    }]);

    assert.equal(result.totalEntrySlippageInr, 20);
    assert.equal(result.totalExitSlippageInr, 30);
    assert.equal(result.totalRiskVarianceInr, 20);
    assert.equal(result.totalStopGapInr, 10);
    assert.equal(result.rows[0].entrySlippagePercentage, 2);
    assert.equal(result.rows[0].maximumEntryRoomUsedPercentage, 40);
    assert.equal(result.rows[0].feesInR, 0.1);
});
