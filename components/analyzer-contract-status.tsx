import { getAnalyzerContractState } from "@/lib/analyzer-contract";

export function AnalyzerContractStatus({ version, publisher }: { version: unknown; publisher: string }) {
    const state = getAnalyzerContractState(version);
    if (state === "current") return null;

    return <div
        role="alert"
        className={`mb-4 rounded-xl border p-4 text-sm ${
            state === "unsupported"
                ? "border-red-200 bg-red-50 text-red-900"
                : "border-amber-200 bg-amber-50 text-amber-900"
        }`}
    >
        <p className="font-semibold">
            {state === "unsupported" ? `Unsupported ${publisher} data contract` : `Legacy ${publisher} data`}
        </p>
        <p className="mt-1">
            {state === "unsupported"
                ? `This record uses contract ${String(version)} and is shown only for diagnosis. Update both projects before relying on it.`
                : "This record predates the versioned Analyzer-to-Tracker contract. It remains visible as history, but its structure was not fully validated."}
        </p>
    </div>;
}
