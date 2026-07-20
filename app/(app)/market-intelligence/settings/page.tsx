import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { StatusBanner } from "@/components/status-banner";
import { FormSubmitButton } from "@/components/form-submit-button";
import { saveCategorySignalMapping, saveSipSignalMapping } from "./actions";

type SearchParams = Promise<{ success?: string; error?: string }>;
type Mapping = { market_key: string; exposure_weight: number | string };

function mappingText(rows: Mapping[]) {
    return rows.map((row) => `${row.market_key}:${(Number(row.exposure_weight) * 100).toFixed(0)}%`).join(", ");
}

export default async function SignalMappingSettingsPage({ searchParams }: { searchParams: SearchParams }) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) redirect("/auth/login");
    const [categoriesResult, sipsResult, categoryMappingsResult, sipMappingsResult] = await Promise.all([
        supabase.from("asset_categories").select("id, name, sort_order").eq("user_id", user.id).order("sort_order"),
        supabase.from("sip_plans").select("id, name, monthly_amount, category_id").eq("user_id", user.id).eq("is_active", true).order("name"),
        supabase.from("category_signal_mappings").select("category_id, market_key, exposure_weight").eq("user_id", user.id),
        supabase.from("sip_signal_mappings").select("sip_plan_id, market_key, exposure_weight").eq("user_id", user.id),
    ]);
    const params = await searchParams;
    const error = categoriesResult.error || sipsResult.error || categoryMappingsResult.error || sipMappingsResult.error;
    const categoryMappings = new Map<string, Mapping[]>();
    for (const row of categoryMappingsResult.data ?? []) categoryMappings.set(row.category_id, [...(categoryMappings.get(row.category_id) ?? []), row]);
    const sipMappings = new Map<string, Mapping[]>();
    for (const row of sipMappingsResult.data ?? []) sipMappings.set(row.sip_plan_id, [...(sipMappings.get(row.sip_plan_id) ?? []), row]);
    const categoryName = new Map((categoriesResult.data ?? []).map((category) => [category.id, category.name]));

    return <main><div className="mx-auto max-w-6xl px-4 py-8">
        <PageHeader title="Signal mappings" description="Tell the analyser which market signals represent each tracker category and SIP plan. The parser accepts percentages and prevents duplicate or incomplete mappings." />
        <StatusBanner success={params.success} error={params.error || error?.message} />
        <Link href="/market-intelligence" className="mb-6 inline-flex text-sm font-medium text-blue-700 hover:underline">← Back to Market Intelligence</Link>
        <section className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-900"><p className="font-semibold">Available market keys</p><p className="mt-1">NIFTY50, NIFTYMID, NIFTYSMALL, VOO, QQQM, VEA, EWY, EWT, EWW, EWZ, BTC, ETH, GOLDSILVER and DEBT.</p><p className="mt-1">Examples: <code>NIFTY50:100%</code> or <code>VOO:35%, QQQM:15%, VEA:50%</code>.</p></section>

        <section className="mt-6"><h2 className="text-xl font-semibold">Category mappings</h2><p className="mt-1 text-sm text-slate-500">Used to connect analyser markets with portfolio target categories.</p><div className="mt-4 grid gap-4 lg:grid-cols-2">{(categoriesResult.data ?? []).map((category) => <form key={category.id} action={saveCategorySignalMapping} className="rounded-xl border border-slate-200 bg-white p-5"><input type="hidden" name="category_id" value={category.id} /><h3 className="font-semibold">{category.name}</h3><label className="mt-4 block text-sm font-medium text-slate-700">Market weights<textarea name="mappings" required rows={3} defaultValue={mappingText(categoryMappings.get(category.id) ?? [])} placeholder="NIFTY50:100%" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-sm" /></label><div className="mt-3"><FormSubmitButton pendingText="Saving mapping...">Save category mapping</FormSubmitButton></div></form>)}</div></section>

        <section className="mt-8"><h2 className="text-xl font-semibold">SIP plan mappings</h2><p className="mt-1 text-sm text-slate-500">Each active SIP must total exactly 100%. These mappings override the Python fallback configuration.</p><div className="mt-4 grid gap-4 lg:grid-cols-2">{(sipsResult.data ?? []).map((sip) => <form key={sip.id} action={saveSipSignalMapping} className="rounded-xl border border-slate-200 bg-white p-5"><input type="hidden" name="sip_plan_id" value={sip.id} /><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{sip.name}</h3><p className="mt-1 text-xs text-slate-500">{categoryName.get(sip.category_id)} · ₹{Number(sip.monthly_amount ?? 0).toLocaleString("en-IN")}</p></div></div><label className="mt-4 block text-sm font-medium text-slate-700">Market weights<textarea name="mappings" required rows={3} defaultValue={mappingText(sipMappings.get(sip.id) ?? [])} placeholder="NIFTY50:80%, NIFTYMID:20%" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-sm" /></label><div className="mt-3"><FormSubmitButton pendingText="Saving mapping...">Save SIP mapping</FormSubmitButton></div></form>)}</div></section>
    </div></main>;
}
