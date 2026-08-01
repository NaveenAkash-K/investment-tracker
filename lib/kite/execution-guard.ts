export const KITE_EXECUTION_PHASE = "paper_auto_only" as const;

/** Batch 3 contains no broker order transport. Keep this guard fail-closed. */
export function assertKiteOrderPlacementAllowed(): never {
    throw new Error("Kite order placement is unavailable during the Paper Auto phase.");
}
