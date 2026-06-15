"use client";

import { ErrorNotification } from "@/components/error-notification";

export default function AppError({
                                     error,
                                     reset,
                                 }: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    return (
        <>
            <ErrorNotification
                message={error.message}
                onRetry={reset}
            />

            <main className="min-h-screen bg-slate-50 px-4 py-24">
                <div className="mx-auto max-w-2xl rounded-xl border border-slate-200 bg-white p-6 text-center">
                    <h1 className="text-xl font-semibold text-slate-950">
                        Action failed
                    </h1>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                        Fix the issue and try again.
                    </p>

                    {error.digest && (
                        <p className="mt-4 font-mono text-xs text-slate-400">
                            Error ID: {error.digest}
                        </p>
                    )}
                </div>
            </main>
        </>
    );
}