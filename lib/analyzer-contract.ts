export const ANALYZER_CONTRACT_VERSION = "2026-07-30.v2" as const;
export const LEGACY_ANALYZER_CONTRACT_VERSION = "legacy-unversioned" as const;
export const PREVIOUS_ANALYZER_CONTRACT_VERSIONS = ["2026-07-28.v1"] as const;

export type AnalyzerContractState = "current" | "legacy" | "unsupported";

export function getAnalyzerContractState(version: unknown): AnalyzerContractState {
    if (version === ANALYZER_CONTRACT_VERSION) return "current";
    if (
        version === null
        || version === undefined
        || version === ""
        || version === LEGACY_ANALYZER_CONTRACT_VERSION
        || PREVIOUS_ANALYZER_CONTRACT_VERSIONS.includes(version as "2026-07-28.v1")
    ) {
        return "legacy";
    }
    return "unsupported";
}

export function isSupportedAnalyzerContract(version: unknown) {
    return getAnalyzerContractState(version) !== "unsupported";
}

export type MonthlySignalRunValidityInput = {
    monthKey: string;
    status: string;
    contractVersion: unknown;
    publicationStatus?: string | null;
};

export function isUsableMonthlySignalRun(
    run: MonthlySignalRunValidityInput,
    expectedMonthKey: string,
) {
    return (
        run.monthKey === expectedMonthKey
        && run.status === "successful"
        && (run.publicationStatus ?? "published") === "published"
        && isSupportedAnalyzerContract(run.contractVersion)
    );
}

export type SwingScanValidityInput = {
    status: string;
    sessionState: string;
    sessionMatchesExpected: boolean;
    contractVersion: unknown;
    publicationStatus?: string | null;
};

export function isUsableSwingScan(scan: SwingScanValidityInput | null | undefined) {
    if (!scan) return false;
    return (
        ["successful", "partial"].includes(scan.status)
        && scan.sessionState === "completed"
        && scan.sessionMatchesExpected
        && (scan.publicationStatus ?? "published") === "published"
        && isSupportedAnalyzerContract(scan.contractVersion)
    );
}
