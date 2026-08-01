import "server-only";

export const KITE_CALLBACK_PATH = "/api/kite/callback";

type Environment = Record<string, string | undefined>;

export type KiteServerConfiguration = {
    apiKey: string;
    apiSecret: string;
    tokenEncryptionKey: string;
    appBaseUrl: string;
    callbackUrl: string;
};

const requiredVariables = [
    "KITE_API_KEY",
    "KITE_API_SECRET",
    "KITE_TOKEN_ENCRYPTION_KEY",
    "INVESTMENT_TRACKER_APP_URL",
] as const;

function normalizedBaseUrl(value: string) {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
        throw new Error("Investment Tracker must use HTTPS outside local development.");
    }
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
}

export function getKiteConfigurationState(environment: Environment = process.env) {
    const missing = requiredVariables.filter((name) => !environment[name]?.trim());
    if (missing.length > 0) return { configured: false as const, missing };

    try {
        normalizedBaseUrl(environment.INVESTMENT_TRACKER_APP_URL!);
        const decodedKey = Buffer.from(environment.KITE_TOKEN_ENCRYPTION_KEY!, "base64");
        if (decodedKey.length !== 32) {
            return { configured: false as const, missing: ["KITE_TOKEN_ENCRYPTION_KEY"] };
        }
    } catch {
        return { configured: false as const, missing: ["INVESTMENT_TRACKER_APP_URL or KITE_TOKEN_ENCRYPTION_KEY"] };
    }

    return { configured: true as const, missing: [] as string[] };
}

export function requireKiteServerConfiguration(environment: Environment = process.env): KiteServerConfiguration {
    const state = getKiteConfigurationState(environment);
    if (!state.configured) throw new Error("Kite server configuration is incomplete.");

    const appBaseUrl = normalizedBaseUrl(environment.INVESTMENT_TRACKER_APP_URL!);
    return {
        apiKey: environment.KITE_API_KEY!.trim(),
        apiSecret: environment.KITE_API_SECRET!.trim(),
        tokenEncryptionKey: environment.KITE_TOKEN_ENCRYPTION_KEY!.trim(),
        appBaseUrl,
        callbackUrl: `${appBaseUrl}${KITE_CALLBACK_PATH}`,
    };
}

