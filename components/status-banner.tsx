export function StatusBanner({
    success,
    error,
}: {
    success?: string;
    error?: string;
}) {
    if (!success && !error) return null;

    return (
        <div
            role={error ? "alert" : "status"}
            aria-live={error ? "assertive" : "polite"}
            className={`mb-6 rounded-xl border p-4 text-sm ${
                error
                    ? "border-red-200 bg-red-50 text-red-800"
                    : "border-emerald-200 bg-emerald-50 text-emerald-800"
            }`}
        >
            <p className="font-semibold">{error ? "Action could not be completed" : "Saved successfully"}</p>
            <p className="mt-1">{error || success}</p>
        </div>
    );
}
