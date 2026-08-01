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

test("Batch 1 has a permanent read-only order guard", () => {
    assert.equal(KITE_EXECUTION_PHASE, "read_only_authentication");
    assert.throws(
        () => assertKiteOrderPlacementAllowed(),
        /order placement is unavailable/i,
    );
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
    assert.doesNotMatch(`${loginRoute}\n${callbackRoute}`, /place_order|\/orders|cancel_order|modify_order/);
});

