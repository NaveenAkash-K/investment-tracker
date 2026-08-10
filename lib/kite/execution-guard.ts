export const KITE_EXECUTION_PHASE = "vps_only_live_execution" as const;

/** The Vercel/Tracker process never owns Kite order transport. */
export function assertKiteOrderPlacementAllowed(): never {
    throw new Error("Kite order placement is restricted to the locked static-IP VPS worker.");
}
