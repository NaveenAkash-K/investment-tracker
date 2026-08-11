import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const safety = readFileSync(
    "supabase/migrations/202608110001_execution_safety_hardening.sql",
    "utf8",
);
const observability = readFileSync(
    "supabase/migrations/202608110002_swing_observability_and_delivery.sql",
    "utf8",
);

test("broker identity is pinned and has an explicit audited reset", () => {
    assert.match(safety, /enforce_kite_broker_identity_pin/);
    assert.match(safety, /reset_kite_broker_identity/);
    assert.match(safety, /kite_broker_identity_reset/);
});

test("entry sizing and claims use maximum-fill, reconciliation and daily loss gates", () => {
    assert.match(safety, /sized_at_maximum_entry/);
    assert.match(safety, /Fresh matched reconciliation is required when an entry is claimed/);
    assert.match(safety, /swing_daily_net_realized/);
    assert.match(safety, /claim_swing_reduce_only_exit/);
    assert.match(safety, /swing_trade_realizations/);
    assert.match(safety, /broker_charges_inr/);
});

test("manual entry requires monitored trigger evidence", () => {
    assert.match(safety, /if v_status <> 'triggered'/);
    assert.match(safety, /Manual entry requires a monitor-confirmed trigger/);
});

test("technical setups and execution scorecards remain separate from candidates", () => {
    assert.match(observability, /create table if not exists public\.swing_setup_watchlist/);
    assert.match(observability, /get_swing_performance_scorecards/);
    assert.match(observability, /get_swing_candidate_lifecycle_scorecard/);
    assert.match(observability, /median_hours_to_trigger/);
    assert.match(observability, /actionability_status/);
});

test("news alert delivery is claimed before SMTP completion", () => {
    assert.match(observability, /claim_news_alert_delivery/);
    assert.match(observability, /complete_news_alert_delivery/);
    assert.match(observability, /status = 'sending'/);
});
