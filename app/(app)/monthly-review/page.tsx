import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { StatusBanner } from "@/components/status-banner";
import { MonthlyReviewForm, type MonthlyReviewFormRow } from "@/components/monthly-review-form";
import {
    buildMonthlyPortfolioReturns,
    calculateLinkedReturn,
    getIndiaMonthStart,
    type TrackingCurrency,
} from "@/lib/performance";
import { saveMonthlyReview } from "./actions";

type SearchParams = Promise<{ success?: string; error?: string }>;

function toNumber(value: unknown) {
    const result = Number(value ?? 0);
    return Number.isFinite(result) ? result : 0;
}

export default async function MonthlyReviewPage({ searchParams }: { searchParams: SearchParams }) {
    const supabase = await createClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) redirect("/auth/login");

    const month = getIndiaMonthStart();
    const [categoriesResult, holdingsResult, sipsResult, historyResult, profileResult] = await Promise.all([
        supabase.from("asset_categories").select("id, name, sort_order, tracking_currency").eq("user_id", user.id).order("sort_order"),
        supabase.from("holdings").select("category_id, currency, current_value, current_value_inr, exchange_rate_to_inr").eq("user_id", user.id).eq("is_active", true),
        supabase.from("sip_plans").select("category_id, monthly_amount").eq("user_id", user.id).eq("is_active", true),
        supabase.from("monthly_category_performance").select("category_id, performance_month, is_baseline, opening_value_inr, contribution_inr, contribution_native, contribution_fx_rate, closing_native_value, closing_fx_rate, market_gain_inr, currency_gain_inr, combined_gain_inr").eq("user_id", user.id).order("performance_month", { ascending: false }),
        supabase.from("profiles").select("default_usd_inr_rate").eq("user_id", user.id).maybeSingle(),
    ]);

    const queryError = categoriesResult.error || holdingsResult.error || sipsResult.error || historyResult.error || profileResult.error;
    if (queryError) {
        return <main className="mx-auto max-w-5xl px-4 py-8"><div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-5 text-red-800"><h1 className="font-semibold">Monthly review unavailable</h1><p className="mt-2 text-sm">{queryError.message}</p><p className="mt-2 text-xs">Apply the included Supabase migration before using monthly performance tracking.</p></div></main>;
    }

    const suggestedByCategoryName = new Map<string, number>();
    const { data: latestSignalRun } = await supabase
        .from("market_signal_runs")
        .select("id")
        .eq("user_id", user.id)
        .eq("run_type", "monthly")
        .order("as_of", { ascending: false })
        .limit(1)
        .maybeSingle();
    if (latestSignalRun?.id) {
        const { data: recommendations } = await supabase
            .from("sip_signal_recommendations")
            .select("category_name, suggested_amount_inr")
            .eq("user_id", user.id)
            .eq("run_id", latestSignalRun.id);
        for (const recommendation of recommendations ?? []) {
            if (!recommendation.category_name) continue;
            suggestedByCategoryName.set(
                recommendation.category_name,
                (suggestedByCategoryName.get(recommendation.category_name) ?? 0) + toNumber(recommendation.suggested_amount_inr)
            );
        }
    }

    const categories = categoriesResult.data ?? [];
    const holdings = holdingsResult.data ?? [];
    const sips = sipsResult.data ?? [];
    const history = historyResult.data ?? [];
    const defaultRate = toNumber(profileResult.data?.default_usd_inr_rate) || 1;
    const currentByCategory = new Map(history.filter((row) => row.performance_month === month).map((row) => [row.category_id, row]));

    const formRows: MonthlyReviewFormRow[] = categories.map((category) => {
        const currency = (category.tracking_currency === "USD" ? "USD" : "INR") as TrackingCurrency;
        const categoryHoldings = holdings.filter((holding) => holding.category_id === category.id);
        const matchingHoldings = currency === "USD" ? categoryHoldings.filter((holding) => holding.currency === "USD") : categoryHoldings;
        const closingNativeValue = matchingHoldings.reduce((sum, holding) => sum + toNumber(currency === "USD" ? holding.current_value : holding.current_value_inr), 0);
        const closingFxRate = currency === "USD"
            ? matchingHoldings.find((holding) => toNumber(holding.exchange_rate_to_inr) > 1)?.exchange_rate_to_inr
            : 1;
        const plannedSip = sips.filter((sip) => sip.category_id === category.id).reduce((sum, sip) => sum + toNumber(sip.monthly_amount), 0);
        const current = currentByCategory.get(category.id);
        const previous = history.find((row) => row.category_id === category.id && row.performance_month < month);

        return {
            categoryId: category.id,
            categoryName: category.name,
            currency,
            closingNativeValue,
            closingFxRate: toNumber(closingFxRate) || defaultRate,
            plannedSip,
            suggestedSip: suggestedByCategoryName.get(category.name) ?? null,
            previousNativeValue: previous ? toNumber(previous.closing_native_value) : null,
            previousFxRate: previous ? toNumber(previous.closing_fx_rate) : null,
            savedContributionInr: toNumber(current?.contribution_inr),
            savedContributionNative: toNumber(current?.contribution_native),
            savedContributionFxRate: toNumber(current?.contribution_fx_rate) || (currency === "USD" ? defaultRate : 1),
            savedClosingFxRate: toNumber(current?.closing_fx_rate) || toNumber(closingFxRate) || defaultRate,
            isBaseline: Boolean(current?.is_baseline),
        };
    });

    const params = await searchParams;
    const currentRows = history.filter((row) => row.performance_month === month);
    const totals = currentRows.reduce((result, row) => ({
        contribution: result.contribution + toNumber(row.contribution_inr),
        market: result.market + toNumber(row.market_gain_inr),
        currency: result.currency + toNumber(row.currency_gain_inr),
        combined: result.combined + toNumber(row.combined_gain_inr),
    }), { contribution: 0, market: 0, currency: 0, combined: 0 });

    const monthlyReturns = buildMonthlyPortfolioReturns(history.map((row) => ({
        performanceMonth: row.performance_month,
        isBaseline: Boolean(row.is_baseline),
        openingValueInr: toNumber(row.opening_value_inr),
        contributionInr: toNumber(row.contribution_inr),
        marketGainInr: toNumber(row.market_gain_inr),
        currencyGainInr: toNumber(row.currency_gain_inr),
        combinedGainInr: toNumber(row.combined_gain_inr),
    })));
    const currentReturn = monthlyReturns.find((row) => row.performanceMonth === month);
    const recentReturns = monthlyReturns.slice(-6).reverse();
    const rolling3 = calculateLinkedReturn(monthlyReturns, 3);
    const rolling6 = calculateLinkedReturn(monthlyReturns, 6);
    const rolling12 = calculateLinkedReturn(monthlyReturns, 12);

    const formatCurrency = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);

    return (
        <main><div className="mx-auto max-w-6xl px-4 py-8">
            <PageHeader title="Monthly Review" description="Record actual contributions once a month and separate real market movement from USD/INR currency movement." />
            <StatusBanner success={params.success} error={params.error} />

            <section className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Summary label="Actual contribution" value={formatCurrency(totals.contribution)} helper="Confirmed, not planned SIP" />
                <Summary label="Market movement" value={formatCurrency(totals.market)} helper={returnHelper(currentReturn?.marketReturnPercentage, "Contribution-adjusted")} tone={totals.market} />
                <Summary label="Currency movement" value={formatCurrency(totals.currency)} helper={returnHelper(currentReturn?.currencyReturnPercentage, "USD/INR return")} tone={totals.currency} />
                <Summary label="Combined gain/loss" value={formatCurrency(totals.combined)} helper={returnHelper(currentReturn?.combinedReturnPercentage, "Total return")} tone={totals.combined} />
            </section>

            <section className="mb-6 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-900">
                <p className="font-semibold">One quick update per month</p>
                <p className="mt-1">Update native holding values first, then confirm actual contributions here. USD categories also capture the conversion and closing exchange rates. A category’s first saved month establishes its baseline.</p>
            </section>

            <section className="mb-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
                <div className="border-b border-slate-100 px-5 py-4">
                    <h2 className="text-lg font-semibold text-slate-950">Contribution-adjusted returns</h2>
                    <p className="mt-1 text-sm leading-6 text-slate-500">
                        Gain divided by opening value plus confirmed contribution. This approximation matches your usual start-of-month investment timing.
                    </p>
                </div>
                <div className="grid gap-3 p-5 sm:grid-cols-3">
                    <ReturnSummary label="Rolling 3 months" value={rolling3} />
                    <ReturnSummary label="Rolling 6 months" value={rolling6} />
                    <ReturnSummary label="Rolling 12 months" value={rolling12} />
                </div>
                {recentReturns.length > 0 ? (
                    <div className="overflow-x-auto border-t border-slate-100">
                        <table className="w-full min-w-[760px] text-left text-sm">
                            <caption className="sr-only">Recent contribution-adjusted monthly portfolio returns</caption>
                            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                <tr>
                                    <th className="px-5 py-3">Review month</th>
                                    <th className="px-5 py-3 text-right">Capital base</th>
                                    <th className="px-5 py-3 text-right">Contribution</th>
                                    <th className="px-5 py-3 text-right">Market return</th>
                                    <th className="px-5 py-3 text-right">Currency return</th>
                                    <th className="px-5 py-3 text-right">Combined return</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {recentReturns.map((row) => (
                                    <tr key={row.performanceMonth}>
                                        <td className="px-5 py-4 font-medium text-slate-950">
                                            {formatMonth(row.performanceMonth)}
                                            {row.baselineRows > 0 && row.trackedRows === 0 ? <span className="ml-2 rounded-full bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">Baseline</span> : null}
                                            {row.baselineRows > 0 && row.trackedRows > 0 ? <span className="ml-2 rounded-full bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">Partial</span> : null}
                                        </td>
                                        <td className="px-5 py-4 text-right tabular-nums">{row.capitalBaseInr > 0 ? formatCurrency(row.capitalBaseInr) : "—"}</td>
                                        <td className="px-5 py-4 text-right tabular-nums">{formatCurrency(row.contributionInr)}</td>
                                        <ReturnCell value={row.marketReturnPercentage} />
                                        <ReturnCell value={row.currencyReturnPercentage} />
                                        <ReturnCell value={row.combinedReturnPercentage} strong />
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : <p className="border-t border-slate-100 p-5 text-sm text-slate-500">Save the first monthly review to establish the performance baseline.</p>}
            </section>

            {formRows.length > 0 ? <MonthlyReviewForm rows={formRows} action={saveMonthlyReview} /> : <div className="rounded-xl border bg-white p-8 text-center text-slate-500">Create an asset category first.</div>}
        </div></main>
    );
}

function Summary({ label, value, helper, tone }: { label: string; value: string; helper: string; tone?: number }) {
    return <div className="rounded-xl border border-slate-200 bg-white p-5"><p className="text-sm font-medium text-slate-500">{label}</p><p className={`mt-2 text-2xl font-bold ${tone === undefined || tone === 0 ? "text-slate-950" : tone > 0 ? "text-emerald-700" : "text-red-700"}`}>{value}</p><p className="mt-1 text-sm text-slate-500">{helper}</p></div>;
}

function formatReturn(value: number | null | undefined) {
    if (value === null || value === undefined) return "Not available";
    return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function returnHelper(value: number | null | undefined, label: string) {
    return value === null || value === undefined
        ? "Available after baseline"
        : `${label}: ${formatReturn(value)}`;
}

function formatMonth(value: string) {
    return new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric", timeZone: "UTC" })
        .format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
}

function ReturnSummary({ label, value }: { label: string; value: number | null }) {
    const tone = value === null || value === 0
        ? "text-slate-950"
        : value > 0 ? "text-emerald-700" : "text-red-700";
    return <div className="rounded-lg bg-slate-50 p-4"><p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p><p className={`mt-2 text-xl font-bold ${tone}`}>{formatReturn(value)}</p><p className="mt-1 text-xs text-slate-400">Requires consecutive non-baseline reviews</p></div>;
}

function ReturnCell({ value, strong = false }: { value: number | null; strong?: boolean }) {
    const tone = value === null || value === 0
        ? "text-slate-500"
        : value > 0 ? "text-emerald-700" : "text-red-700";
    return <td className={`px-5 py-4 text-right tabular-nums ${strong ? "font-semibold" : ""} ${tone}`}>{formatReturn(value)}</td>;
}
