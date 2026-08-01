import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireKiteServerConfiguration } from "@/lib/kite/config";

function swingRedirect(request: NextRequest, type: "success" | "error", message: string) {
    const url = new URL("/swing-lab", request.url);
    url.searchParams.set(type, message);
    return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
        return NextResponse.redirect(new URL("/auth/login", request.url));
    }

    let configuration;
    try {
        configuration = requireKiteServerConfiguration();
    } catch {
        return swingRedirect(request, "error", "Kite server configuration is incomplete.");
    }

    const state = randomBytes(32).toString("base64url");
    const stateHash = createHash("sha256").update(state).digest("hex");
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    const { error } = await supabase.rpc("begin_kite_auth_attempt", {
        p_state_hash: stateHash,
        p_return_to: "/swing-lab",
        p_expires_at: expiresAt.toISOString(),
    });
    if (error) return swingRedirect(request, "error", `Could not start Kite authentication: ${error.message}`);

    const redirectParameters = new URLSearchParams({ state });
    const kiteLogin = new URL("https://kite.zerodha.com/connect/login");
    kiteLogin.searchParams.set("v", "3");
    kiteLogin.searchParams.set("api_key", configuration.apiKey);
    kiteLogin.searchParams.set("redirect_params", redirectParameters.toString());

    const response = NextResponse.redirect(kiteLogin);
    response.headers.set("Cache-Control", "no-store");
    return response;
}
