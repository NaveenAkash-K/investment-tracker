import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
    ANALYZER_CONTRACT_VERSION,
    getAnalyzerContractState,
    isDisplayableMonthlySignalRun,
    isUsableMonthlySignalRun,
    isUsableSwingScan,
    LEGACY_ANALYZER_CONTRACT_VERSION,
    PREVIOUS_ANALYZER_CONTRACT_VERSIONS,
} from "../lib/analyzer-contract.ts";

const contractBytes = readFileSync(new URL("../contracts/analyzer-tracker-contract.v2.json", import.meta.url));
const contract = JSON.parse(contractBytes.toString("utf8")) as {
    contract_version: string;
    legacy_version: string;
    payloads: Record<string, { required: string[]; properties: Record<string, unknown> }>;
};

test("Tracker contract constants match the checked-in JSON contract", () => {
    assert.equal(
        createHash("sha256").update(contractBytes).digest("hex"),
        "c8cb8511c0b2e56e2c16172a74932fc01395944c70473688a44ab6976af7fa46"
    );
    assert.equal(contract.contract_version, ANALYZER_CONTRACT_VERSION);
    assert.equal(contract.legacy_version, LEGACY_ANALYZER_CONTRACT_VERSION);
    assert.deepEqual(Object.keys(contract.payloads).sort(), ["market_run", "news_run", "swing_monitor", "swing_scan"]);
});

test("every analyzer payload requires version, identity, status and model metadata", () => {
    for (const [kind, schema] of Object.entries(contract.payloads)) {
        assert.ok(schema.required.includes("contract_version"), `${kind} lacks contract_version`);
        assert.ok(schema.required.includes("as_of"), `${kind} lacks as_of`);
        assert.ok(schema.required.includes("status"), `${kind} lacks status`);
        assert.ok(schema.required.includes("model_version"), `${kind} lacks model_version`);
        assert.ok(
            schema.required.includes("run_id") || schema.required.includes("scan_id") || schema.required.includes("monitor_id"),
            `${kind} lacks a durable identifier`
        );
    }
});

test("UI differentiates current, legacy and unsupported analyzer records", () => {
    assert.equal(getAnalyzerContractState(ANALYZER_CONTRACT_VERSION), "current");
    assert.equal(getAnalyzerContractState(null), "legacy");
    assert.equal(getAnalyzerContractState(LEGACY_ANALYZER_CONTRACT_VERSION), "legacy");
    assert.equal(getAnalyzerContractState(PREVIOUS_ANALYZER_CONTRACT_VERSIONS[0]), "legacy");
    assert.equal(getAnalyzerContractState("future-v99"), "unsupported");
});

test("hardening migration retains one legacy version and rejects unknown versions", () => {
    const migration = readFileSync(
        new URL("../supabase/migrations/202607280002_reliability_hardening.sql", import.meta.url),
        "utf8"
    );
    assert.match(migration, /'legacy-unversioned', '2026-07-28\.v1'/);
    assert.match(migration, /Unsupported Analyzer contract version/);
    assert.match(migration, /revoke insert, update, delete .* authenticated/);
    assert.match(migration, /Monthly Review is incomplete/);
    assert.match(migration, /acknowledged_missing/);
});

test("monthly comparisons require the current month and a successful supported publication", () => {
    const valid = {
        monthKey: "2026-07",
        status: "successful",
        contractVersion: ANALYZER_CONTRACT_VERSION,
        publicationStatus: "published",
    };
    assert.equal(isUsableMonthlySignalRun(valid, "2026-07"), true);
    assert.equal(isUsableMonthlySignalRun({ ...valid, monthKey: "2026-06" }, "2026-07"), false);
    assert.equal(isUsableMonthlySignalRun({ ...valid, status: "partial" }, "2026-07"), false);
    assert.equal(isUsableMonthlySignalRun({ ...valid, publicationStatus: "failed" }, "2026-07"), false);
    assert.equal(isUsableMonthlySignalRun({ ...valid, contractVersion: "future-v99" }, "2026-07"), false);
});

test("read-only monthly sections may display a current published partial run", () => {
    const valid = {
        monthKey: "2026-08",
        status: "partial",
        contractVersion: ANALYZER_CONTRACT_VERSION,
        publicationStatus: "published",
    };
    assert.equal(isDisplayableMonthlySignalRun(valid, "2026-08"), true);
    assert.equal(isDisplayableMonthlySignalRun({ ...valid, status: "successful" }, "2026-08"), true);
    assert.equal(isDisplayableMonthlySignalRun({ ...valid, status: "failed" }, "2026-08"), false);
    assert.equal(isDisplayableMonthlySignalRun({ ...valid, monthKey: "2026-07" }, "2026-08"), false);
    assert.equal(isDisplayableMonthlySignalRun({ ...valid, publicationStatus: "failed" }, "2026-08"), false);
    assert.equal(isDisplayableMonthlySignalRun({ ...valid, contractVersion: "future-v99" }, "2026-08"), false);
});

test("swing entries require a confirmed published price session", () => {
    const valid = {
        status: "successful",
        sessionState: "completed",
        sessionMatchesExpected: true,
        contractVersion: ANALYZER_CONTRACT_VERSION,
        publicationStatus: "published",
    };
    assert.equal(isUsableSwingScan(valid), true);
    assert.equal(isUsableSwingScan({ ...valid, status: "partial" }), true);
    assert.equal(isUsableSwingScan({ ...valid, status: "failed" }), false);
    assert.equal(isUsableSwingScan({ ...valid, sessionState: "no_session" }), false);
    assert.equal(isUsableSwingScan({ ...valid, sessionMatchesExpected: false }), false);
    assert.equal(isUsableSwingScan({ ...valid, contractVersion: "future-v99" }), false);
});

test("entry RPC cannot bypass failed or stale swing scans", () => {
    const migration = readFileSync(
        new URL("../supabase/migrations/202607280003_partial_finding_closure.sql", import.meta.url),
        "utf8"
    );
    assert.match(migration, /v_candidate_scan\.session_state <> 'completed'/);
    assert.match(migration, /v_latest_scan\.session_state <> 'completed'/);
    assert.match(migration, /not v_latest_scan\.session_matches_expected/);
    assert.match(migration, /p_entry_date - v_latest_scan\.expected_price_session > 3/);
    assert.match(migration, /revoke all on function public\.confirm_swing_entry_review_v2/);
});

test("rereview migration stores truthful monitor coverage and idempotent deliveries", () => {
    const migration = readFileSync(
        new URL("../supabase/migrations/202607290001_rereview_fixes.sql", import.meta.url),
        "utf8"
    );
    assert.match(migration, /candidates_requested integer not null/);
    assert.match(migration, /candidates_evaluated integer not null/);
    assert.match(migration, /failed_candidate_ids jsonb not null/);
    assert.match(migration, /claim_analyzer_notification_delivery/);
    assert.match(migration, /complete_analyzer_notification_delivery/);
    assert.match(migration, /restore_complete_portfolio_backup_v7/);
});

test("second rereview migration enforces monitor truth and backward restore compatibility", () => {
    const migration = readFileSync(
        new URL("../supabase/migrations/202607300001_second_rereview_fixes.sql", import.meta.url),
        "utf8"
    );
    const monitorSchema = contract.payloads.swing_monitor;
    for (const field of [
        "candidates_requested",
        "positions_requested",
        "candidates_evaluated",
        "positions_evaluated",
        "failed_candidate_ids",
        "failed_trade_ids",
    ]) {
        assert.ok(monitorSchema.required.includes(field), `swing_monitor does not require ${field}`);
    }
    assert.match(migration, /2026-07-30\.v2/);
    assert.match(migration, /evaluated counts cannot exceed requested counts/);
    assert.match(migration, /requested, evaluated and failed counts do not reconcile/);
    assert.match(migration, /not in \('2026-07-30\.v2', '2026-07-28\.v1', 'legacy-unversioned'\)/);
    assert.match(migration, /value \|\| jsonb_build_object/);
    assert.match(migration, /perform public\.restore_complete_portfolio_backup_v6\(v_compatible_backup\)/);
    assert.match(migration, /resolve_analyzer_notification_delivery/);
    assert.match(migration, /interval '15 minutes'/);
});

test("monthly comparison does not render a missing suggestion as zero", () => {
    const page = readFileSync(
        new URL("../app/(app)/market-intelligence/page.tsx", import.meta.url),
        "utf8"
    );
    assert.match(page, /suggestedByCategory\.has\(category\) \? money\(.+\) : "Unavailable"/);
});

test("global and strategic-policy explanations are persisted and restored", () => {
    const migration = readFileSync(
        new URL("../supabase/migrations/202608010001_global_policy_signals.sql", import.meta.url),
        "utf8"
    );
    const page = readFileSync(
        new URL("../app/(app)/market-intelligence/page.tsx", import.meta.url),
        "utf8"
    );
    const restoreAction = readFileSync(
        new URL("../app/(app)/import-export/actions.ts", import.meta.url),
        "utf8"
    );
    assert.match(migration, /base_weight_percentage numeric/);
    assert.match(migration, /adjustment_percentage numeric/);
    assert.match(migration, /restore_global_policy_signal_details/);
    assert.match(migration, /restore_complete_portfolio_backup_v8/);
    assert.match(restoreAction, /restore_complete_portfolio_backup_v9/);
    assert.match(page, /Strategic allocation signals/);
    assert.match(page, /Price session not applicable/);
    assert.match(page, /Base shows the regime-adjusted strategic allocation/);
});
