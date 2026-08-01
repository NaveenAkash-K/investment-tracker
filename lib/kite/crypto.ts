import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const KITE_TOKEN_ENCRYPTION_VERSION = 1;

export type EncryptedKiteToken = {
    ciphertext: string;
    iv: string;
    authTag: string;
    version: typeof KITE_TOKEN_ENCRYPTION_VERSION;
};

function decodeKey(encodedKey: string) {
    const key = Buffer.from(encodedKey, "base64");
    if (key.length !== 32) throw new Error("Kite token encryption key must decode to exactly 32 bytes.");
    return key;
}

function associatedData(userId: string) {
    if (!userId.trim()) throw new Error("A user id is required to protect a Kite token.");
    return Buffer.from(`investment-tracker:kite-session:v1:${userId}`, "utf8");
}

export function encryptKiteAccessToken(accessToken: string, encodedKey: string, userId: string): EncryptedKiteToken {
    if (!accessToken.trim()) throw new Error("Kite returned an empty access token.");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", decodeKey(encodedKey), iv);
    cipher.setAAD(associatedData(userId));
    const ciphertext = Buffer.concat([cipher.update(accessToken, "utf8"), cipher.final()]);

    return {
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
        version: KITE_TOKEN_ENCRYPTION_VERSION,
    };
}

export function decryptKiteAccessToken(token: EncryptedKiteToken, encodedKey: string, userId: string) {
    if (token.version !== KITE_TOKEN_ENCRYPTION_VERSION) throw new Error("Unsupported Kite token encryption version.");
    const decipher = createDecipheriv(
        "aes-256-gcm",
        decodeKey(encodedKey),
        Buffer.from(token.iv, "base64"),
    );
    decipher.setAAD(associatedData(userId));
    decipher.setAuthTag(Buffer.from(token.authTag, "base64"));
    return Buffer.concat([
        decipher.update(Buffer.from(token.ciphertext, "base64")),
        decipher.final(),
    ]).toString("utf8");
}

