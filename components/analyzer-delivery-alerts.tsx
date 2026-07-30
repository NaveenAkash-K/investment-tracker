import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { FormSubmitButton } from "@/components/form-submit-button";

export type AnalyzerDelivery = {
    id: string;
    delivery_key: string;
    channel: string;
    status: "claimed" | "uncertain";
    attempt_count: number;
    claimed_at: string;
    last_attempt_at: string;
    error_message: string | null;
};

function dateTime(value: string) {
    return new Intl.DateTimeFormat("en-IN", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Kolkata",
    }).format(new Date(value));
}

export function AnalyzerDeliveryAlerts({
    deliveries,
    returnTo,
    resolveAction,
}: {
    deliveries: AnalyzerDelivery[];
    returnTo: "/market-intelligence" | "/swing-lab";
    resolveAction: (formData: FormData) => void | Promise<void>;
}) {
    if (!deliveries.length) return null;

    return <section role="alert" className="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-5 text-amber-950">
        <h2 className="font-semibold">Unresolved analyzer email delivery</h2>
        <p className="mt-1 text-sm leading-6">
            The Tracker has the published analysis, but cannot prove whether these emails were sent.
            Verify your inbox first. Allowing retry makes the next rerun eligible to send; it does not send immediately.
            A newly claimed delivery may still be active, so recovery is blocked until it is at least 15 minutes old.
        </p>
        <div className="mt-4 space-y-3">
            {deliveries.map((delivery) => <article key={delivery.id} className="rounded-lg border border-amber-200 bg-white p-4">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                        <p className="font-medium">{delivery.channel.replaceAll("-", " ")}</p>
                        <p className="text-xs text-slate-500">
                            Claimed {dateTime(delivery.claimed_at)} · attempt {delivery.attempt_count} · {delivery.status}
                        </p>
                    </div>
                    <code className="max-w-full truncate text-[11px] text-slate-400">{delivery.delivery_key}</code>
                </div>
                {delivery.error_message ? <p className="mt-2 text-xs text-red-700">{delivery.error_message}</p> : null}
                <div className="mt-3 flex flex-wrap gap-2">
                    <form action={resolveAction}>
                        <input type="hidden" name="delivery_id" value={delivery.id} />
                        <input type="hidden" name="resolution_action" value="retry" />
                        <input type="hidden" name="return_to" value={returnTo} />
                        <input type="hidden" name="resolution_note" value="Retry authorized from Investment Tracker after inbox verification." />
                        <FormSubmitButton pendingText="Authorizing...">Allow next retry</FormSubmitButton>
                    </form>
                    <form action={resolveAction}>
                        <input type="hidden" name="delivery_id" value={delivery.id} />
                        <input type="hidden" name="resolution_action" value="dismiss" />
                        <input type="hidden" name="return_to" value={returnTo} />
                        <input type="hidden" name="resolution_note" value="Dismissed from Investment Tracker after inbox verification." />
                        <ConfirmSubmitButton
                            confirmation="Dismiss this unresolved email record? Future automatic retries for this logical notification will stay suppressed."
                            pendingText="Dismissing..."
                        >
                            Dismiss
                        </ConfirmSubmitButton>
                    </form>
                </div>
            </article>)}
        </div>
    </section>;
}
