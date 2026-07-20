import { redirect } from "next/navigation";
import { ArchiveRestore, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { createClient } from "@/lib/supabase/server";
import {
    permanentlyDeleteHolding,
    permanentlyDeleteSipPlan,
    restoreHolding,
    restoreSipPlan,
} from "./actions";

type Category = { id: string; name: string };
type ArchivedHolding = { id: string; category_id: string; name: string; current_value_inr: number | string | null; notes: string | null };
type ArchivedSip = { id: string; category_id: string; name: string; monthly_amount: number | string | null; notes: string | null };

const money = (value: unknown) => new Intl.NumberFormat("en-IN", {
    style: "currency", currency: "INR", maximumFractionDigits: 0,
}).format(Number(value ?? 0));

export default async function ArchivePage() {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) redirect("/auth/login");

    const [categoriesResult, holdingsResult, sipResult] = await Promise.all([
        supabase.from("asset_categories").select("id, name").eq("user_id", user.id),
        supabase.from("holdings").select("id, category_id, name, current_value_inr, notes").eq("user_id", user.id).eq("is_active", false).order("name"),
        supabase.from("sip_plans").select("id, category_id, name, monthly_amount, notes").eq("user_id", user.id).eq("is_active", false).order("name"),
    ]);
    const queryError = categoriesResult.error || holdingsResult.error || sipResult.error;
    if (queryError) throw new Error(queryError.message);

    const categoryNames = new Map(((categoriesResult.data ?? []) as Category[]).map((item) => [item.id, item.name]));
    const holdings = (holdingsResult.data ?? []) as ArchivedHolding[];
    const sips = (sipResult.data ?? []) as ArchivedSip[];

    return <main className="mx-auto max-w-7xl px-4 py-8">
        <PageHeader title="Archive" description="Restore records you hid, or permanently remove them when you are certain they are no longer needed." />
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            Permanent deletion cannot be undone. Download a full backup first if you may need the record later.
        </div>
        <ArchiveSection title="Archived holdings" empty="No archived holdings.">
            {holdings.map((holding) => <ArchiveCard key={holding.id} title={holding.name} subtitle={`${categoryNames.get(holding.category_id) ?? "Unknown category"} · ${money(holding.current_value_inr)}`} notes={holding.notes}
                restoreAction={restoreHolding} deleteAction={permanentlyDeleteHolding} field="holding_id" id={holding.id} />)}
        </ArchiveSection>
        <ArchiveSection title="Archived SIP plans" empty="No archived SIP plans.">
            {sips.map((sip) => <ArchiveCard key={sip.id} title={sip.name} subtitle={`${categoryNames.get(sip.category_id) ?? "Unknown category"} · ${money(sip.monthly_amount)}/month`} notes={sip.notes}
                restoreAction={restoreSipPlan} deleteAction={permanentlyDeleteSipPlan} field="sip_plan_id" id={sip.id} />)}
        </ArchiveSection>
    </main>;
}

function ArchiveSection({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
    const count = Array.isArray(children) ? children.length : 0;
    return <section className="mb-6 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-slate-950">{title}</h2>
        {count === 0 ? <p className="mt-4 text-sm text-slate-500">{empty}</p> : <div className="mt-4 grid gap-4 md:grid-cols-2">{children}</div>}
    </section>;
}

function ArchiveCard({ title, subtitle, notes, restoreAction, deleteAction, field, id }: {
    title: string; subtitle: string; notes: string | null; field: string; id: string;
    restoreAction: (formData: FormData) => Promise<void>; deleteAction: (formData: FormData) => Promise<void>;
}) {
    return <article className="rounded-lg border border-slate-200 p-4">
        <h3 className="font-semibold text-slate-950">{title}</h3>
        <p className="mt-1 text-sm text-slate-600">{subtitle}</p>
        {notes && <p className="mt-2 text-sm text-slate-500">{notes}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
            <form action={restoreAction}><input type="hidden" name={field} value={id} /><ConfirmSubmitButton confirmation={`Restore ${title}?`} pendingLabel="Restoring…" className="inline-flex items-center gap-2 rounded-lg bg-slate-950 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"><ArchiveRestore className="h-4 w-4" />Restore</ConfirmSubmitButton></form>
            <form action={deleteAction}><input type="hidden" name={field} value={id} /><ConfirmSubmitButton confirmation={`Permanently delete ${title}? This cannot be undone.`} pendingLabel="Deleting…" className="inline-flex items-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"><Trash2 className="h-4 w-4" />Delete forever</ConfirmSubmitButton></form>
        </div>
    </article>;
}
