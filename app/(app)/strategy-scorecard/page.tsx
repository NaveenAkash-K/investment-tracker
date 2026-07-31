import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { getIndiaMonthKey } from "@/lib/performance";
import { isSupportedAnalyzerContract } from "@/lib/analyzer-contract";
import { calculateAllocationOutcome, calculateAverageRecommendationTurnover, summarizeTradesByRegime } from "@/lib/strategy-scorecard";

type Run = { id: string; as_of: string; data_coverage: number | string; contract_version: string | null };
type Recommendation = { run_id: string; sip_plan_id: string | null; fund_name: string; category_name: string | null; target_only_amount_inr: number | string; suggested_amount_inr: number | string };
type Performance = { performance_month: string; category_id: string; is_baseline: boolean; opening_value_inr: number | string; contribution_inr: number | string; combined_gain_inr: number | string };
type Trade = { candidate_id: string | null; realized_pnl_inr: number | string | null; realized_r_multiple: number | string | null };

function num(value: unknown) {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: unknown) {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(num(value));
}

function percentage(value: number | null) {
    return value === null ? "Collecting data" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export default async function StrategyScorecardPage() {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) redirect("/auth/login");

    const runsResult = await supabase.from("market_signal_runs").select("id, as_of, data_coverage, contract_version").eq("user_id", user.id).eq("run_type", "monthly").eq("status", "successful").eq("publication_status", "published").order("as_of", { ascending: false }).limit(24);
    if (runsResult.error) return <main className="mx-auto max-w-5xl px-4 py-8"><PageHeader title="Strategy Scorecard" description="Observed decision-system results." /><div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-5 text-red-900">{runsResult.error.message}</div></main>;
    const runs = ((runsResult.data ?? []) as Run[]).filter((run) => isSupportedAnalyzerContract(run.contract_version));
    const runIds = runs.map((run) => run.id);
    const [recommendationsResult, scoresResult, performanceResult, categoriesResult, tradesResult, candidatesResult] = await Promise.all([
        runIds.length ? supabase.from("sip_signal_recommendations").select("run_id, sip_plan_id, fund_name, category_name, target_only_amount_inr, suggested_amount_inr").eq("user_id", user.id).in("run_id", runIds) : Promise.resolve({ data: [], error: null }),
        runIds.length ? supabase.from("market_signal_scores").select("run_id, score_change").eq("user_id", user.id).in("run_id", runIds) : Promise.resolve({ data: [], error: null }),
        supabase.from("monthly_category_performance").select("performance_month, category_id, is_baseline, opening_value_inr, contribution_inr, combined_gain_inr").eq("user_id", user.id).order("performance_month"),
        supabase.from("asset_categories").select("id, name").eq("user_id", user.id),
        supabase.from("swing_trades").select("candidate_id, realized_pnl_inr, realized_r_multiple").eq("user_id", user.id).eq("status", "closed"),
        supabase.from("swing_candidates").select("id, market_regime").eq("user_id", user.id),
    ]);
    const queryError = recommendationsResult.error || scoresResult.error || performanceResult.error || categoriesResult.error || tradesResult.error || candidatesResult.error;
    if (queryError) return <main className="mx-auto max-w-5xl px-4 py-8"><PageHeader title="Strategy Scorecard" description="Observed decision-system results." /><div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-5 text-red-900">{queryError.message}</div></main>;

    const recommendations = (recommendationsResult.data ?? []) as Recommendation[];
    const recommendationsByRun = new Map<string, Recommendation[]>();
    for (const row of recommendations) recommendationsByRun.set(row.run_id, [...(recommendationsByRun.get(row.run_id) ?? []), row]);
    const turnover = calculateAverageRecommendationTurnover(runs.map((run) => ({
        month: getIndiaMonthKey(run.as_of),
        weightsByKey: Object.fromEntries((recommendationsByRun.get(run.id) ?? []).map((row) => [row.sip_plan_id ?? row.fund_name, num(row.suggested_amount_inr)])),
    })));

    const categoryNameById = new Map((categoriesResult.data ?? []).map((category) => [category.id, category.name]));
    const performanceRows = (performanceResult.data ?? []) as Performance[];
    const performanceByMonthCategory = new Map<string, Performance>();
    for (const row of performanceRows) {
        const category = categoryNameById.get(row.category_id);
        if (category) performanceByMonthCategory.set(`${row.performance_month.slice(0, 7)}:${category}`, row);
    }

    const monthlyOutcomes = runs.flatMap((run) => {
        const month = getIndiaMonthKey(run.as_of);
        const grouped = new Map<string, { target: number; suggested: number }>();
        for (const row of recommendationsByRun.get(run.id) ?? []) {
            if (!row.category_name) continue;
            const current = grouped.get(row.category_name) ?? { target: 0, suggested: 0 };
            current.target += num(row.target_only_amount_inr);
            current.suggested += num(row.suggested_amount_inr);
            grouped.set(row.category_name, current);
        }
        const inputs = [...grouped.entries()].map(([category, amounts]) => {
            const performance = performanceByMonthCategory.get(`${month}:${category}`);
            const capitalBase = performance && !performance.is_baseline ? num(performance.opening_value_inr) + num(performance.contribution_inr) : 0;
            return {
                category,
                targetOnlyAmount: amounts.target,
                suggestedAmount: amounts.suggested,
                combinedReturnPercentage: capitalBase > 0 ? num(performance?.combined_gain_inr) / capitalBase * 100 : null,
            };
        });
        const outcome = calculateAllocationOutcome(inputs);
        return outcome.eligibleCategories > 0 ? [{ month, ...outcome }] : [];
    }).sort((left, right) => right.month.localeCompare(left.month));

    const adherenceRows = runs.flatMap((run) => {
        const month = getIndiaMonthKey(run.as_of);
        const suggested = (recommendationsByRun.get(run.id) ?? []).reduce((sum, row) => sum + num(row.suggested_amount_inr), 0);
        const actual = performanceRows.filter((row) => row.performance_month.startsWith(month)).reduce((sum, row) => sum + num(row.contribution_inr), 0);
        return suggested > 0 && actual > 0 ? [{ month, suggested, actual, difference: actual - suggested }] : [];
    });
    const averageAdherenceGap = adherenceRows.length
        ? adherenceRows.reduce((sum, row) => sum + Math.abs(row.difference) / row.suggested * 100, 0) / adherenceRows.length
        : null;
    const averageCoverage = runs.length ? runs.reduce((sum, run) => sum + num(run.data_coverage), 0) / runs.length * 100 : null;
    const scoreChanges = (scoresResult.data ?? []).flatMap((row) => row.score_change === null ? [] : [Math.abs(num(row.score_change))]);
    const averageScoreChange = scoreChanges.length ? scoreChanges.reduce((sum, value) => sum + value, 0) / scoreChanges.length : null;

    const regimeByCandidate = new Map((candidatesResult.data ?? []).map((candidate) => [candidate.id, candidate.market_regime ?? "UNKNOWN"]));
    const regimeRows = summarizeTradesByRegime(((tradesResult.data ?? []) as Trade[]).map((trade) => ({
        regime: trade.candidate_id ? regimeByCandidate.get(trade.candidate_id) ?? "UNKNOWN" : "UNKNOWN",
        realizedPnlInr: num(trade.realized_pnl_inr),
        realizedRMultiple: trade.realized_r_multiple === null ? null : num(trade.realized_r_multiple),
    })));
    const targetGain = monthlyOutcomes.reduce((sum, row) => sum + row.targetOnlyGainInr, 0);
    const signalGain = monthlyOutcomes.reduce((sum, row) => sum + row.signalAdjustedGainInr, 0);
    const sampleReady = runs.length >= 12 && monthlyOutcomes.length >= 12;

    return <main><div className="mx-auto max-w-6xl px-4 py-8">
        <PageHeader title="Strategy Scorecard" description="Observational evidence from published recommendations, actual monthly reviews and confirmed Swing trades. Nothing here automatically changes model weights." />
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Metric label="Monthly samples" value={`${runs.length}/12`} helper={sampleReady ? "Minimum observation window reached" : "Do not draw conclusions yet"} /><Metric label="Recommendation turnover" value={percentage(turnover)} helper="Average allocation-weight change" /><Metric label="Actual vs suggested gap" value={percentage(averageAdherenceGap)} helper={`${adherenceRows.length} reviewed months · absolute gap`} /><Metric label="Average data coverage" value={percentage(averageCoverage)} helper={averageScoreChange === null ? "Score stability collecting" : `Mean score movement ${averageScoreChange.toFixed(1)} points`} /></section>

        <section className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white"><div className="border-b border-slate-100 px-5 py-4"><h2 className="text-lg font-semibold">Target-only versus signal-adjusted new money</h2><p className="mt-1 text-sm text-slate-500">Applies each reviewed category’s observed contribution-adjusted return to the two suggested allocations. This compares only that month’s new money, not total-portfolio performance.</p></div>{monthlyOutcomes.length ? <><div className="grid gap-3 p-5 sm:grid-cols-3"><Metric label="Target-only modeled gain" value={money(targetGain)} helper={`${monthlyOutcomes.length} comparable months`} /><Metric label="Signal-adjusted modeled gain" value={money(signalGain)} helper={`${monthlyOutcomes.length} comparable months`} /><Metric label="Observed difference" value={money(signalGain - targetGain)} helper={sampleReady ? "Review alongside turnover and risk" : "Sample is too small for a verdict"} /></div><div className="overflow-x-auto border-t border-slate-100"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-5 py-3">Month</th><th className="px-5 py-3 text-right">Categories</th><th className="px-5 py-3 text-right">Target-only return</th><th className="px-5 py-3 text-right">Signal-adjusted return</th><th className="px-5 py-3 text-right">Modeled gain difference</th></tr></thead><tbody className="divide-y divide-slate-100">{monthlyOutcomes.map((row) => <tr key={row.month}><td className="px-5 py-4 font-medium">{row.month}</td><td className="px-5 py-4 text-right">{row.eligibleCategories}</td><td className="px-5 py-4 text-right">{percentage(row.targetOnlyReturnPercentage)}</td><td className="px-5 py-4 text-right">{percentage(row.signalAdjustedReturnPercentage)}</td><td className="px-5 py-4 text-right font-semibold">{money(row.signalAdjustedGainInr - row.targetOnlyGainInr)}</td></tr>)}</tbody></table></div></> : <p className="p-5 text-sm text-slate-500">Comparable outcomes appear after a published monthly recommendation is followed by a non-baseline Monthly Review.</p>}</section>

        <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5"><h2 className="text-lg font-semibold">Swing outcomes by entry regime</h2><p className="mt-1 text-sm text-slate-500">Regime is taken from the candidate that started the confirmed trade. Keep paper and live execution context in mind.</p>{regimeRows.length ? <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{regimeRows.map((row) => <div key={row.regime} className="rounded-lg bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{row.regime}</p><p className="mt-2 text-xl font-bold">{row.trades} trades</p><p className="mt-1 text-sm text-slate-600">{row.winRatePercentage.toFixed(0)}% wins · {row.averageRMultiple === null ? "R unavailable" : `${row.averageRMultiple.toFixed(2)}R average`}</p><p className="mt-1 text-sm font-medium">{money(row.totalPnlInr)}</p></div>)}</div> : <p className="mt-4 text-sm text-slate-500">Close confirmed Swing trades to begin regime evaluation.</p>}</section>

        <section className={`mt-6 rounded-xl border p-5 ${sampleReady ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}><h2 className="font-semibold">{sampleReady ? "Observation window reached" : "Still collecting forward evidence"}</h2><p className="mt-1 text-sm">{sampleReady ? "The minimum sample gate is open, but review consistency, drawdowns and changing market regimes before modifying the model." : `There are ${runs.length} valid monthly recommendations and ${monthlyOutcomes.length} comparable outcome months. Keep the model observational until at least 12 comparable months exist.`}</p></section>
    </div></main>;
}

function Metric({ label, value, helper }: { label: string; value: string; helper: string }) {
    return <div className="rounded-xl border border-slate-200 bg-white p-5"><p className="text-sm text-slate-500">{label}</p><p className="mt-2 text-2xl font-bold text-slate-950">{value}</p><p className="mt-1 text-xs text-slate-500">{helper}</p></div>;
}
