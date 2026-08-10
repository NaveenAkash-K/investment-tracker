import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
    decryptKiteAccessToken,
    encryptKiteAccessToken,
    KITE_TOKEN_ENCRYPTION_VERSION,
} from "../lib/kite/crypto.ts";
import { assertKiteOrderPlacementAllowed, KITE_EXECUTION_PHASE } from "../lib/kite/execution-guard.ts";
import { getNextKiteSessionExpiry, maskBrokerUserId } from "../lib/kite/session.ts";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");

test("Kite access tokens round-trip through user-bound AES-GCM encryption", () => {
    const encrypted = encryptKiteAccessToken("daily-access-token", encryptionKey, "user-123");
    assert.equal(encrypted.version, KITE_TOKEN_ENCRYPTION_VERSION);
    assert.notEqual(encrypted.ciphertext, "daily-access-token");
    assert.equal(decryptKiteAccessToken(encrypted, encryptionKey, "user-123"), "daily-access-token");
    assert.throws(() => decryptKiteAccessToken(encrypted, encryptionKey, "different-user"));
});

test("invalid encryption keys and empty tokens fail closed", () => {
    assert.throws(() => encryptKiteAccessToken("token", Buffer.alloc(16).toString("base64"), "user-123"));
    assert.throws(() => encryptKiteAccessToken("", encryptionKey, "user-123"));
});

test("Kite session expiry is the following calendar day at 06:00 IST", () => {
    assert.equal(
        getNextKiteSessionExpiry(new Date("2026-08-02T03:30:00.000Z")).toISOString(),
        "2026-08-03T00:30:00.000Z",
    );
    assert.equal(
        getNextKiteSessionExpiry(new Date("2026-08-02T20:00:00.000Z")).toISOString(),
        "2026-08-04T00:30:00.000Z",
    );
});

test("broker ids are masked before display", () => {
    assert.equal(maskBrokerUserId("AB1234"), "AB••••");
    assert.equal(maskBrokerUserId(null), "Unavailable");
});

test("Tracker routes retain a permanent broker-order guard", () => {
    assert.equal(KITE_EXECUTION_PHASE, "vps_only_live_execution");
    assert.throws(
        () => assertKiteOrderPlacementAllowed(),
        /static-IP VPS worker/i,
    );
});

test("Phase 8 and 9 migration keeps browser writes out of broker transport", () => {
    const migration = readFileSync(
        new URL("../supabase/migrations/202608100002_swing_live_execution.sql", import.meta.url),
        "utf8",
    );
    assert.match(migration, /observed_below_trigger boolean not null default false/);
    assert.match(migration, /approval_status in \('not_required', 'pending', 'approved', 'rejected', 'expired'\)/);
    assert.match(migration, /for update skip locked limit 1/);
    assert.match(migration, /An automatic protective stop cannot move downward/);
    assert.match(migration, /grant execute on function public\.record_swing_broker_execution\(uuid,text,jsonb\) to service_role/);
    assert.match(migration, /grant execute on function public\.decide_swing_assisted_intent\(uuid,text\) to authenticated/);
    assert.doesNotMatch(migration, /grant execute on function public\.record_swing_broker_execution\(uuid,text,jsonb\) to authenticated/);
    assert.match(migration, /broker_execution_enabled=false/);
});

test("credential rotation is not an execution-readiness gate", () => {
    const migration = readFileSync(
        new URL("../supabase/migrations/202608100003_remove_credential_rotation_gate.sql", import.meta.url),
        "utf8",
    );
    const swingPage = readFileSync(new URL("../app/(app)/swing-lab/page.tsx", import.meta.url), "utf8");
    assert.match(migration, /ensure_swing_credentials_compatibility/);
    assert.match(migration, /Credential rotation is not an execution-readiness prerequisite/);
    assert.doesNotMatch(swingPage, /Credential rotation is still required/);
    assert.doesNotMatch(swingPage, /Exposed service-role key was rotated/);
});

test("Personal Free GTT Assisted stays separate, explicit and same-session", () => {
    const migration = readFileSync(
        new URL("../supabase/migrations/202608100004_personal_free_gtt_assisted.sql", import.meta.url),
        "utf8",
    );
    const swingPage = readFileSync(new URL("../app/(app)/swing-lab/page.tsx", import.meta.url), "utf8");
    assert.match(migration, /gtt_assisted_enabled boolean not null default false/);
    assert.match(migration, /Current LTP must still be below the entry trigger/);
    assert.match(migration, /time '09:20'[\s\S]*time '15:05'/);
    assert.match(migration, /time '15:20'/);
    assert.match(migration, /target_r_multiple numeric\(8,4\) not null default 2/);
    assert.match(migration, /grant execute on function public\.create_swing_gtt_assisted_entry\(uuid,numeric\) to authenticated/);
    assert.match(migration, /grant execute on function public\.record_swing_gtt_assisted_state[\s\S]*?to service_role/);
    assert.doesNotMatch(migration, /grant execute on function public\.record_swing_gtt_assisted_state[^;]*to authenticated/);
    assert.match(swingPage, /Handled by Zerodha GTT/);
    assert.match(swingPage, /Unavailable · Personal Free/);
    assert.match(swingPage, /disabled=\{!kiteConnected \|\| controls\.market_data_plan !== "connect"\}/);
    assert.match(swingPage, /name="live_max_deployed_inr"[^>]*min=\{500\} step=\{500\}/);
    assert.match(swingPage, /name="live_daily_loss_limit_inr"[^>]*min=\{10\} step=\{10\}/);
});

test("Paper Auto migration remains simulated, idempotent and service-role controlled", () => {
    const migration = readFileSync(
        new URL("../supabase/migrations/202608020003_swing_paper_auto.sql", import.meta.url),
        "utf8",
    );
    assert.match(migration, /execution_source in \('manual', 'paper_auto', 'assisted_live', 'live_auto'\)/);
    assert.match(migration, /unique \(user_id, event_key\)/);
    assert.match(migration, /Paper Auto is not armed for new entries/);
    assert.match(migration, /grant execute on function public\.publish_swing_paper_cycle\(uuid, jsonb\)\s+to service_role/);
    assert.match(migration, /broker_order_placed', false/);
    assert.doesNotMatch(migration, /insert into public\.swing_(?:order_intents|broker_orders|broker_fills|protective_orders)/);
});

test("Kite worker migration exposes only service-role read-only cycle functions", () => {
    const migration = readFileSync(
        new URL("../supabase/migrations/202608020002_kite_readonly_worker.sql", import.meta.url),
        "utf8",
    );
    assert.match(migration, /get_kite_worker_bootstrap/);
    assert.match(migration, /publish_kite_readonly_cycle/);
    assert.match(migration, /Batch 2 accepts observe mode only/);
    assert.match(migration, /grant execute on function public\.get_kite_worker_bootstrap\(uuid\) to service_role/);
    assert.doesNotMatch(migration, /place_order|modify_order|cancel_order|submit_order/);
});

test("Kite migration isolates secrets and defaults automation to advisory and disarmed", () => {
    const migration = readFileSync(
        new URL("../supabase/migrations/202608020001_swing_kite_auth_foundation.sql", import.meta.url),
        "utf8",
    );
    assert.match(migration, /automation_mode text not null default 'advisory'/);
    assert.match(migration, /new_entries_enabled boolean not null default false/);
    assert.match(migration, /live_auto_unlocked boolean not null default false/);
    assert.match(migration, /for update;/);
    assert.match(migration, /set consumed_at = now\(\)/);
    assert.match(migration, /revoke all on table public\.kite_broker_sessions from public, anon, authenticated/);
    assert.match(migration, /revoke all on table public\.kite_auth_attempts from public, anon, authenticated/);
    assert.doesNotMatch(migration, /grant select on table public\.kite_broker_sessions to authenticated/);
});

test("Kite routes only authenticate and exchange a session token", () => {
    const loginRoute = readFileSync(new URL("../app/api/kite/login/route.ts", import.meta.url), "utf8");
    const callbackRoute = readFileSync(new URL("../app/api/kite/callback/route.ts", import.meta.url), "utf8");
    assert.match(loginRoute, /redirect_params/);
    assert.match(callbackRoute, /api\.kite\.trade\/session\/token/);
    assert.doesNotMatch(`${loginRoute}\n${callbackRoute}`, /export const dynamic/);
    assert.doesNotMatch(`${loginRoute}\n${callbackRoute}`, /place_order|\/orders|cancel_order|modify_order/);
});

test("Phase 7 readiness migration records evidence while keeping both live modes locked", () => {
    const migration = readFileSync(
        new URL("../supabase/migrations/202608100001_swing_execution_readiness.sql", import.meta.url),
        "utf8",
    );
    assert.match(migration, /assisted_live_unlocked boolean not null default false/);
    assert.match(migration, /broker_execution_enabled boolean not null default false/);
    assert.match(migration, /market_data_plan in \('personal', 'connect'\)/);
    assert.match(migration, /fresh_quote_cycle_count/);
    assert.match(migration, /Paper Auto entry events observed/);
    assert.match(migration, /existing_protection_unchanged', true/);
    assert.match(migration, /automation_mode = 'advisory', new_entries_enabled = false/);
    assert.doesNotMatch(migration, /place_order|modify_order|cancel_order|submit_order/);
});
