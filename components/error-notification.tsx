"use client";

export function ErrorNotification({
                                      message,
                                      onRetry,
                                  }: {
    message: string;
    onRetry?: () => void;
}) {
    return (
        <div role="alert" aria-live="assertive" className="fixed left-1/2 top-4 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 rounded-xl border border-red-200 bg-red-50 p-4 text-red-800 shadow-lg">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <p className="font-semibold">Something went wrong</p>
                    <p className="mt-1 text-sm leading-6">
                        {message || "Please try again."}
                    </p>
                </div>

                {onRetry && (
                    <button
                        type="button"
                        onClick={onRetry}
                        className="rounded-lg bg-red-700 px-3 py-2 text-sm font-medium text-white hover:bg-red-800"
                    >
                        Retry
                    </button>
                )}
            </div>
        </div>
    );
}
