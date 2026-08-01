const IST_OFFSET_MINUTES = 330;

/** Kite retail access tokens expire at 06:00 IST on the following calendar day. */
export function getNextKiteSessionExpiry(now = new Date()) {
    const indiaClock = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000);
    return new Date(Date.UTC(
        indiaClock.getUTCFullYear(),
        indiaClock.getUTCMonth(),
        indiaClock.getUTCDate() + 1,
        0,
        30,
        0,
        0,
    ));
}

export function maskBrokerUserId(value: string | null | undefined) {
    if (!value) return "Unavailable";
    if (value.length <= 2) return "••";
    return `${value.slice(0, 2)}${"•".repeat(Math.min(value.length - 2, 6))}`;
}

