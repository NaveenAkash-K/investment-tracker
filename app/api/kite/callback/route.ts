import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireKiteServerConfiguration } from "@/lib/kite/config";
import { encryptKiteAccessToken } from "@/lib/kite/crypto";
import { getNextKiteSessionExpiry } from "@/lib/kite/session";

type KiteTokenPayload = {
    status?: string;
    message?: string;
    data?: {
        user_id?: string;
        user_name?: string;
        access_token?: string;
    };
};

function swingRedirect(request: NextRequest, type: "success" | "error", message: string) {
    const url = new URL("/swing-lab", request.url);
    url.searchParams.set(type, message);
    return NextResponse.redirect(url);
}

function validState(value: string | null): value is string {
    return Boolean(value && /^[A-Za-z0-9_-]{40,100}$/.test(value));
}

async function markAttemptFailed(
    supabase: Awaited<ReturnType<typeof createClient>>,
    state: string,
    reason: string,
) {
    const stateHash = createHash("sha256").update(state).digest("hex");
    await supabase.rpc("fail_kite_auth_attempt", { p_state_hash: stateHash, p_reason: reason });
}

export async function GET(request: NextRequest) {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
        return swingRedirect(request, "error", "Sign in to Investment Tracker before connecting Kite.");
    }

    const state = request.nextUrl.searchParams.get("state");
    if (!validState(state)) {
        return swingRedirect(request, "error", "Kite returned an invalid authentication state. Start again from Swing Lab.");
    }

    const action = request.nextUrl.searchParams.get("action");
    const status = request.nextUrl.searchParams.get("status");
    const requestToken = request.nextUrl.searchParams.get("request_token");
    if (action !== "login" || status !== "success" || !requestToken) {
        await markAttemptFailed(supabase, state, "Kite login was cancelled or did not complete.");
        return swingRedirect(request, "error", "Kite login was cancelled or did not complete.");
    }

    let configuration;
    try {
        configuration = requireKiteServerConfiguration();
    } catch {
        await markAttemptFailed(supabase, state, "Kite server configuration was incomplete.");
        return swingRedirect(request, "error", "Kite server configuration is incomplete.");
    }

    try {
        const checksum = createHash("sha256")
            .update(`${configuration.apiKey}${requestToken}${configuration.apiSecret}`)
            .digest("hex");
        const tokenResponse = await fetch("https://api.kite.trade/session/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "X-Kite-Version": "3",
            },
            body: new URLSearchParams({
                api_key: configuration.apiKey,
                request_token: requestToken,
                checksum,
            }),
            cache: "no-store",
            signal: AbortSignal.timeout(15_000),
        });
        const payload = await tokenResponse.json() as KiteTokenPayload;
        if (!tokenResponse.ok || payload.status !== "success") {
            throw new Error(payload.message || "Kite rejected the session exchange.");
        }

        const brokerUserId = payload.data?.user_id?.trim();
        const accessToken = payload.data?.access_token?.trim();
        if (!brokerUserId || !accessToken) throw new Error("Kite returned an incomplete session.");

        const issuedAt = new Date();
        const expiresAt = getNextKiteSessionExpiry(issuedAt);
        const encrypted = encryptKiteAccessToken(
            accessToken,
            configuration.tokenEncryptionKey,
            user.id,
        );
        const stateHash = createHash("sha256").update(state).digest("hex");
        const { error } = await supabase.rpc("complete_kite_auth_attempt", {
            p_state_hash: stateHash,
            p_broker_user_id: brokerUserId,
            p_user_name: payload.data?.user_name?.trim() || null,
            p_encrypted_access_token: encrypted.ciphertext,
            p_encryption_iv: encrypted.iv,
            p_encryption_auth_tag: encrypted.authTag,
            p_token_version: encrypted.version,
            p_issued_at: issuedAt.toISOString(),
            p_expires_at: expiresAt.toISOString(),
        });
        if (error) throw new Error(error.message);

        return swingRedirect(request, "success", "Kite connected for today in read-only mode.");
    } catch (error) {
        const message = error instanceof Error ? error.message : "Kite session exchange failed.";
        await markAttemptFailed(supabase, state, message);
        return swingRedirect(request, "error", `Kite connection failed: ${message}`);
    }
}
