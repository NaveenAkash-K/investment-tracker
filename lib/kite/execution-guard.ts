export const KITE_EXECUTION_PHASE = "read_only_authentication" as const;

/** Batch 1 contains no broker order transport. Keep this guard fail-closed. */
export function assertKiteOrderPlacementAllowed(): never {
    throw new Error("Kite order placement is unavailable during the read-only authentication phase.");
}

