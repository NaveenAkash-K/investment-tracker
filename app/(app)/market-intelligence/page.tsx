import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { StatusBanner } from "@/components/status-banner";
import { FormSubmitButton } from "@/components/form-submit-button";
import { AnalyzerContractStatus } from "@/components/analyzer-contract-status";
import { AnalyzerDeliveryAlerts, type AnalyzerDelivery } from "@/components/analyzer-delivery-alerts";
import { isUsableMonthlySignalRun } from "@/lib/analyzer-contract";
import { getIndiaDate, getIndiaMonthKey, getIndiaMonthStart, getLatestExpectedDailyRunDate } from "@/lib/performance";
import { resolveAnalyzerDelivery } from "../analyzer-deliveries/actions";
import { acknowledgeSignalAlert, saveSignalDecision } from "./actions";

type SearchParams = Promise<{ success?: string; error?: string }>;
type SignalRun = {
    id: string;
    run_type: "daily" | "weekly" | "monthly";
    as_of: string;
    status: "successful" | "partial" | "failed";
    model_version: string;
    contract_version: string | null;
    publication_status: string | null;
    macro_regime: string | null;
    dollar_regime: string | null;
    usd_inr_rate: number | string | null;
    data_coverage: number | string;
    data_issues: unknown;
    decision_status: "pending" | "accepted" | "modified" | "skipped";
    decision_note: string | null;
};
type MarketScore = {
    id: string;
    run_id: string;
    market_key: string;
    name: string;
    symbol: string | null;
    final_score: number | string;
    score_change: number | string | null;
    action: string;
    data_coverage: number | string;
    actionable: boolean;
    price_as_of: string | null;
    valuation_score: number | string | null;
    technical_score: number | string | null;
    macro_score: number | string | null;
    portfolio_fit_score: number | string | null;
    risk_score: number | string | null;
    valuation_source: string | null;
    valuation_as_of: string | null;
    valuation_method: string | null;
    metrics: unknown;
};
type SipRecommendation = {
    id: string;
    run_id: string;
    sip_plan_id: string | null;
    fund_name: string;
    category_name: string | null;
    planned_amount_inr: number | string;
    target_only_amount_inr: number | string;
    suggested_amount_inr: number | string;
    score: number | string | null;
    data_coverage: number | string;
    projected_category_percentage: number | string | null;
    reason: string | null;
};
type GlobalRecommendation = {
    id: string;
    instrument: string;
    amount_inr: number | string;
    approximate_usd: number | string | null;
    weight_percentage: number | string;
    score: number | string | null;
};
type SignalAlert = {
    id: string;
    alert_type: string;
    asset: string | null;
    title: string;
    message: string | null;
    recommended_action: string | null;
    acknowledged_at: string | null;
    created_at: string;
};

function number(value: unknown) {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: unknown) {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(number(value));
}

function formatDate(value: string | null) {
    if (!value) return "Unavailable";
    return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: value.includes("T") ? "short" : undefined, timeZone: "Asia/Kolkata" }).format(new Date(value));
}

function issues(value: unknown): Array<{ severity?: string; source?: string; message?: string }> {
    return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

export default async function MarketIntelligencePage({ searchParams }: { searchParams: SearchParams }) {
    const supabase = await createClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) redirect("/auth/login");

    const runsResult = await supabase
        .from("market_signal_runs")
        .select("id, run_type, as_of, status, model_version, contract_version, publication_status, macro_regime, dollar_regime, usd_inr_rate, data_coverage, data_issues, decision_status, decision_note")
        .eq("user_id", user.id)
        .order("as_of", { ascending: false })
        .limit(120);

    const params = await searchParams;
    if (runsResult.error) {
        return <main className="mx-auto max-w-5xl px-4 py-8"><PageHeader title="Market Intelligence" description="Market signals and monthly decision support." /><StatusBanner success={params.success} error={params.error} /><div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-amber-900"><h2 className="font-semibold">Market Intelligence is not ready</h2><p className="mt-2 text-sm">{runsResult.error.message}</p><p className="mt-2 text-sm">Apply the market-intelligence Supabase migration, then enable Supabase publishing in the analyser configuration.</p></div></main>;
    }

    const runs = (runsResult.data ?? []) as SignalRun[];
    const latestRun = runs[0];
    const currentMonthKey = getIndiaMonthStart().slice(0, 7);
    const mostRecentMonthly = runs.find((run) => run.run_type === "monthly");
    const currentMonthAttempt = runs.find(
        (run) => run.run_type === "monthly" && getIndiaMonthKey(run.as_of) === currentMonthKey
    );
    const latestMonthly = currentMonthAttempt && isUsableMonthlySignalRun({
        monthKey: getIndiaMonthKey(currentMonthAttempt.as_of),
        status: currentMonthAttempt.status,
        contractVersion: currentMonthAttempt.contract_version,
        publicationStatus: currentMonthAttempt.publication_status,
    }, currentMonthKey)
        ? currentMonthAttempt
        : undefined;
    const previousMonthly = latestMonthly
        ? runs.find((run) => (
            run.run_type === "monthly"
            && run.id !== latestMonthly.id
            && new Date(run.as_of).getTime() < new Date(latestMonthly.as_of).getTime()
            && isUsableMonthlySignalRun({
                monthKey: getIndiaMonthKey(run.as_of),
                status: run.status,
                contractVersion: run.contract_version,
                publicationStatus: run.publication_status,
            }, getIndiaMonthKey(run.as_of))
        ))
        : undefined;
    const runIds = [latestRun?.id, latestMonthly?.id, previousMonthly?.id].filter(Boolean) as string[];
    const monthlyRunIds = [latestMonthly?.id, previousMonthly?.id].filter(Boolean) as string[];

    const [scoresResult, sipResult, globalResult, alertsResult, categoriesResult, performanceResult, deliveriesResult] = await Promise.all([
        runIds.length ? supabase.from("market_signal_scores").select("id, run_id, market_key, name, symbol, final_score, score_change, action, data_coverage, actionable, price_as_of, valuation_score, valuation_source, valuation_as_of, valuation_method, technical_score, macro_score, portfolio_fit_score, risk_score, metrics").eq("user_id", user.id).in("run_id", runIds) : Promise.resolve({ data: [], error: null }),
        monthlyRunIds.length ? supabase.from("sip_signal_recommendations").select("id, run_id, sip_plan_id, fund_name, category_name, planned_amount_inr, target_only_amount_inr, suggested_amount_inr, score, data_coverage, projected_category_percentage, reason").eq("user_id", user.id).in("run_id", monthlyRunIds).order("fund_name") : Promise.resolve({ data: [], error: null }),
        latestMonthly ? supabase.from("global_signal_recommendations").select("id, instrument, amount_inr, approximate_usd, weight_percentage, score").eq("user_id", user.id).eq("run_id", latestMonthly.id).order("weight_percentage", { ascending: false }) : Promise.resolve({ data: [], error: null }),
        supabase.from("market_signal_alerts").select("id, alert_type, asset, title, message, recommended_action, acknowledged_at, created_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(20),
        supabase.from("asset_categories").select("id, name").eq("user_id", user.id),
        supabase.from("monthly_category_performance").select("category_id, contribution_inr").eq("user_id", user.id).eq("performance_month", getIndiaMonthStart()),
        supabase.from("analyzer_notification_deliveries").select("id, delivery_key, channel, status, attempt_count, claimed_at, last_attempt_at, error_message").eq("user_id", user.id).in("status", ["claimed", "uncertain"]).order("claimed_at", { ascending: false }).limit(20),
    ]);

    const secondaryError = scoresResult.error || sipResult.error || globalResult.error || alertsResult.error || categoriesResult.error || performanceResult.error || deliveriesResult.error;
    const scores = ((scoresResult.data ?? []) as MarketScore[]).filter((score) => score.run_id === latestRun?.id).sort((a, b) => number(b.final_score) - number(a.final_score));
    const allSipRows = (sipResult.data ?? []) as SipRecommendation[];
    const sipRows = allSipRows.filter((row) => row.run_id === latestMonthly?.id);
    const previousSipRows = allSipRows.filter((row) => row.run_id === previousMonthly?.id);
    const previousSipByKey = new Map(previousSipRows.map((row) => [row.sip_plan_id ?? row.fund_name, row]));
    const globalRows = (globalResult.data ?? []) as GlobalRecommendation[];
    const alertRows = (alertsResult.data ?? []) as SignalAlert[];
    const deliveryRows = (deliveriesResult.data ?? []) as AnalyzerDelivery[];
    const categoryName = new Map((categoriesResult.data ?? []).map((category) => [category.id, category.name]));
    const actualByCategory = new Map<string, number>();
    for (const row of performanceResult.data ?? []) {
        const name = categoryName.get(row.category_id);
        if (name) actualByCategory.set(name, (actualByCategory.get(name) ?? 0) + number(row.contribution_inr));
    }
    const suggestedByCategory = new Map<string, number>();
    for (const row of sipRows) if (row.category_name) suggestedByCategory.set(row.category_name, (suggestedByCategory.get(row.category_name) ?? 0) + number(row.suggested_amount_inr));

    const coverage = latestRun ? number(latestRun.data_coverage) * 100 : 0;
    const activeAlerts = alertRows.filter((alert) => !alert.acknowledged_at);
    const latestIssues = latestRun ? issues(latestRun.data_issues) : [];
    const expectedDailyRunDate = getLatestExpectedDailyRunDate(8, 0, 120);
    const dailyHeartbeatMissed = !latestRun || getIndiaDate(new Date(latestRun.as_of)) < expectedDailyRunDate;

    return <main><div className="mx-auto max-w-7xl px-4 py-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <PageHeader title="Market Intelligence" description="Daily alerts, weekly changes and a bounded monthly SIP decision—kept separate from actual portfolio records." />
            <Link href="/market-intelligence/settings" className="inline-flex w-fit rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50">Configure signal mappings</Link>
        </div>
        <StatusBanner success={params.success} error={params.error || secondaryError?.message} />
        <AnalyzerDeliveryAlerts deliveries={deliveryRows} returnTo="/market-intelligence" resolveAction={resolveAnalyzerDelivery} />
        {latestRun ? <AnalyzerContractStatus version={latestRun.contract_version} publisher="Portfolio Analyzer" /> : null}
        {dailyHeartbeatMissed ? <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900"><p className="font-semibold">Portfolio analyser heartbeat is missing</p><p className="mt-1">No daily, weekly or monthly run was published for the latest expected date, {expectedDailyRunDate}. Check the GitHub Action and Supabase publication step.</p></div> : latestRun?.status === "failed" ? <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">The latest portfolio analyser run failed. Its recommendations are not current.</div> : null}

        {!latestRun ? <EmptyState /> : <>
            <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Summary label="Latest run" value={latestRun.run_type.toUpperCase()} helper={formatDate(latestRun.as_of)} />
                <Summary label="Data coverage" value={`${coverage.toFixed(0)}%`} helper={latestRun.status === "successful" ? "All mandatory controls passed" : "Review data warnings"} tone={coverage >= 80 ? "good" : "warn"} />
                <Summary label="Macro regime" value={latestRun.macro_regime ?? "Unknown"} helper={latestRun.dollar_regime ?? "Dollar data unavailable"} />
                <Summary label="Active alerts" value={String(activeAlerts.length)} helper={`Model ${latestRun.model_version}`} tone={activeAlerts.length ? "warn" : "good"} />
            </section>

            <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><h2 className="text-lg font-semibold">Current market signals</h2><p className="mt-1 text-sm text-slate-500">Markets with insufficient input coverage or stale prices are blocked instead of receiving a neutral recommendation.</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">USD/INR {latestRun.usd_inr_rate ? number(latestRun.usd_inr_rate).toFixed(2) : "N/A"}</span></div>
                <MarketScoresTable scores={scores} />
            </section>

            <section className="mt-6 grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
                <div className="rounded-xl border border-slate-200 bg-white p-5"><div className="flex items-start justify-between gap-4"><div><h2 className="text-lg font-semibold">Monthly SIP decision</h2><p className="mt-1 text-sm text-slate-500">Planned and target-only amounts form the baseline; the suggested column contains the bounded signal tilt.</p></div>{latestMonthly && <span className="text-xs text-slate-500">{formatDate(latestMonthly.as_of)}</span>}</div>
                    {sipRows.length ? <SipDecisionTable rows={sipRows} previousByKey={previousSipByKey} previousRun={previousMonthly} /> : <p className="mt-5 rounded-lg bg-slate-50 p-4 text-sm text-slate-500">{currentMonthAttempt ? `The ${currentMonthKey} monthly run is ${currentMonthAttempt.status}, unpublished, or uses an unsupported contract, so it is not being compared with actual investment.` : mostRecentMonthly ? `No valid monthly recommendation has been published for ${currentMonthKey}. The most recent run is ${formatDate(mostRecentMonthly.as_of)}.` : "No monthly recommendation has been published yet."}</p>}
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-5"><h2 className="text-lg font-semibold">Decision journal</h2><p className="mt-1 text-sm text-slate-500">Record whether you followed or changed the latest monthly suggestion. This does not update holdings.</p>{latestMonthly ? <form action={saveSignalDecision} className="mt-5 space-y-4"><input type="hidden" name="run_id" value={latestMonthly.id} /><label className="block text-sm font-medium text-slate-700">Decision<select name="decision_status" defaultValue={latestMonthly.decision_status} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2"><option value="pending">Pending</option><option value="accepted">Accepted</option><option value="modified">Modified</option><option value="skipped">Skipped</option></select></label><label className="block text-sm font-medium text-slate-700">Note<textarea name="decision_note" defaultValue={latestMonthly.decision_note ?? ""} rows={5} placeholder="Why you followed or changed the suggestion" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" /></label><FormSubmitButton pendingText="Saving decision...">Save decision</FormSubmitButton></form> : <p className="mt-4 text-sm text-slate-500">A monthly run is required.</p>}</div>
            </section>

            <section className="mt-6 grid gap-6 lg:grid-cols-2"><div className="rounded-xl border border-slate-200 bg-white p-5"><h2 className="text-lg font-semibold">Suggested versus actual this month</h2><p className="mt-1 text-sm text-slate-500">Actual values come from Monthly Review and remain authoritative.</p>{!latestMonthly ? <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Suggested amounts are unavailable because no valid, successful recommendation has been published for {currentMonthKey}.</p> : null}<div className="mt-4 space-y-3">{Array.from(new Set([...suggestedByCategory.keys(), ...actualByCategory.keys()])).map((category) => <div key={category} className="grid grid-cols-[1fr_auto_auto] gap-4 rounded-lg bg-slate-50 p-3 text-sm"><span className="font-medium">{category}</span><span className="text-slate-500">Suggested {suggestedByCategory.has(category) ? money(suggestedByCategory.get(category)) : "Unavailable"}</span><span className="font-semibold">Actual {money(actualByCategory.get(category))}</span></div>)}</div><Link href="/monthly-review" className="mt-4 inline-flex rounded-lg bg-slate-950 px-4 py-2 text-sm font-medium text-white">Open Monthly Review</Link></div>
                <div className="rounded-xl border border-slate-200 bg-white p-5"><h2 className="text-lg font-semibold">Global split</h2><p className="mt-1 text-sm text-slate-500">Indicative conversion only; actual FX remains in Monthly Review.</p><div className="mt-4 space-y-3">{globalRows.map((row) => <div key={row.id} className="flex items-center justify-between rounded-lg bg-slate-50 p-3 text-sm"><div><p className="font-medium">{row.instrument}</p><p className="text-xs text-slate-500">Score {number(row.score).toFixed(1)} · {number(row.weight_percentage).toFixed(1)}%</p></div><div className="text-right"><p className="font-semibold">{money(row.amount_inr)}</p><p className="text-xs text-slate-500">{row.approximate_usd === null ? "N/A" : `$${number(row.approximate_usd).toFixed(2)}`}</p></div></div>)}</div></div></section>

            <section className="mt-6 grid gap-6 lg:grid-cols-2"><div className="rounded-xl border border-slate-200 bg-white p-5"><h2 className="text-lg font-semibold">Alerts</h2><div className="mt-4 space-y-3">{alertRows.length ? alertRows.map((alert) => <article key={alert.id} className={`rounded-lg border p-4 ${alert.acknowledged_at ? "border-slate-200 bg-slate-50" : "border-amber-200 bg-amber-50"}`}><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{alert.alert_type} · {alert.asset}</p><h3 className="mt-1 font-semibold">{alert.title}</h3></div><span className="text-xs text-slate-500">{formatDate(alert.created_at)}</span></div><p className="mt-2 text-sm text-slate-600">{alert.message}</p><p className="mt-2 text-sm font-medium text-slate-800">{alert.recommended_action}</p>{!alert.acknowledged_at && <form action={acknowledgeSignalAlert} className="mt-3"><input type="hidden" name="alert_id" value={alert.id} /><button className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900">Acknowledge</button></form>}</article>) : <p className="text-sm text-slate-500">No alerts have been published.</p>}</div></div>
                <div className="rounded-xl border border-slate-200 bg-white p-5"><h2 className="text-lg font-semibold">Data health</h2><div className="mt-4 space-y-3">{latestIssues.length ? latestIssues.map((issue, index) => <div key={`${issue.source}-${index}`} className={`rounded-lg border p-3 text-sm ${issue.severity === "error" ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}><p className="font-semibold">{issue.source ?? "Unknown source"}</p><p className="mt-1">{issue.message}</p></div>) : <p className="rounded-lg bg-emerald-50 p-4 text-sm text-emerald-800">No data issues were recorded in the latest run.</p>}</div></div></section>

            <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5"><h2 className="text-lg font-semibold">Run history</h2><p className="mt-1 text-sm text-slate-500">Use this history to evaluate signal stability and recommendation turnover instead of judging one month in isolation.</p><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{runs.slice(0, 36).map((run) => <article key={run.id} className="rounded-lg border border-slate-200 p-4"><div className="flex items-center justify-between"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium uppercase">{run.run_type}</span><span className="text-xs text-slate-500">{(number(run.data_coverage) * 100).toFixed(0)}% coverage</span></div><p className="mt-3 font-medium">{formatDate(run.as_of)}</p><p className="mt-1 text-xs text-slate-500">{run.status} · Model {run.model_version}</p></article>)}</div></section>
        </>}
    </div></main>;
}

function objectValue(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function MarketScoresTable({ scores }: { scores: MarketScore[] }) {
    return <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[1260px] text-left text-sm">
        <caption className="sr-only">Latest market scores, valuation proxies, completed price sessions and data coverage</caption>
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Market</th><th className="px-4 py-3 text-right">Final</th><th className="px-4 py-3 text-right">Change</th><th className="px-4 py-3">Valuation proxy</th><th className="px-4 py-3 text-right">Technical</th><th className="px-4 py-3 text-right">Portfolio fit</th><th className="px-4 py-3 text-right">Safety</th><th className="px-4 py-3 text-right">Data coverage</th><th className="px-4 py-3">Posture</th><th className="px-4 py-3">Price session</th></tr></thead>
        <tbody className="divide-y divide-slate-100">{scores.map((score) => {
            const metrics = objectValue(score.metrics);
            const expected = typeof metrics.expected_price_session === "string" ? metrics.expected_price_session : null;
            const actual = typeof metrics.actual_price_session === "string" ? metrics.actual_price_session : score.price_as_of;
            const missed = number(metrics.missed_market_sessions);
            const matches = Boolean(expected && actual === expected);
            return <tr key={score.id}><td className="px-4 py-3"><p className="font-medium text-slate-950">{score.market_key}</p><p className="text-xs text-slate-500">{score.name}</p></td><NumberCell value={score.final_score} /><DeltaCell value={score.score_change} /><ValuationCell score={score} /><NumberCell value={score.technical_score} /><NumberCell value={score.portfolio_fit_score} /><NumberCell value={score.risk_score} /><td className="px-4 py-3 text-right">{(number(score.data_coverage) * 100).toFixed(0)}%</td><td className="px-4 py-3"><SignalBadge action={score.action} actionable={score.actionable} /></td><td className="px-4 py-3"><p className={matches ? "font-medium text-emerald-700" : expected ? "font-medium text-red-700" : "text-slate-500"}>{actual ?? "Unavailable"}</p><p className="mt-1 text-xs text-slate-400">{expected ? matches ? `Expected ${expected}` : `Expected ${expected}${missed > 0 ? ` · ${missed} session${missed === 1 ? "" : "s"} missed` : ""}` : "Legacy run: expected session unavailable"}</p></td></tr>;
        })}</tbody>
    </table></div>;
}

function SipDecisionTable({ rows, previousByKey, previousRun }: { rows: SipRecommendation[]; previousByKey: Map<string, SipRecommendation>; previousRun?: SignalRun }) {
    return <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[1080px] text-left text-sm">
        <caption className="sr-only">Current monthly SIP recommendation compared with the previous valid monthly recommendation</caption>
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Fund</th><th className="px-4 py-3 text-right">Planned</th><th className="px-4 py-3 text-right">Target-only</th><th className="px-4 py-3 text-right">Previous</th><th className="px-4 py-3 text-right">Suggested</th><th className="px-4 py-3 text-right">Change</th><th className="px-4 py-3 text-right">Coverage</th><th className="px-4 py-3">Why now</th></tr></thead>
        <tbody className="divide-y divide-slate-100">{rows.map((row) => {
            const previous = previousByKey.get(row.sip_plan_id ?? row.fund_name);
            const currentAmount = number(row.suggested_amount_inr);
            const previousAmount = previous ? number(previous.suggested_amount_inr) : null;
            const difference = previousAmount === null ? null : currentAmount - previousAmount;
            const percentage = previousAmount && difference !== null ? difference / previousAmount * 100 : null;
            const material = difference !== null && Math.abs(difference) >= Math.max(500, Math.abs(previousAmount ?? 0) * 0.1);
            return <tr key={row.id}><td className="px-4 py-3"><p className="font-medium text-slate-950">{row.fund_name}</p><p className="text-xs text-slate-500">{row.category_name}</p></td><td className="px-4 py-3 text-right">{money(row.planned_amount_inr)}</td><td className="px-4 py-3 text-right">{money(row.target_only_amount_inr)}</td><td className="px-4 py-3 text-right"><p>{previousAmount === null ? "Unavailable" : money(previousAmount)}</p>{previousRun ? <p className="text-xs text-slate-400">{getIndiaMonthKey(previousRun.as_of)}</p> : null}</td><td className="px-4 py-3 text-right font-semibold">{money(currentAmount)}</td><td className={`px-4 py-3 text-right ${difference === null || difference === 0 ? "text-slate-500" : difference > 0 ? "text-emerald-700" : "text-red-700"}`}><p className="font-medium">{difference === null ? "New" : `${difference > 0 ? "+" : ""}${money(difference)}`}</p><p className="text-xs">{percentage === null ? "No comparison" : `${percentage > 0 ? "+" : ""}${percentage.toFixed(1)}%`}{material ? " · material" : ""}</p></td><td className="px-4 py-3 text-right">{(number(row.data_coverage) * 100).toFixed(0)}%</td><td className="max-w-sm px-4 py-3 text-slate-600">{row.reason ?? "No explanation was published."}</td></tr>;
        })}</tbody>
    </table></div>;
}

function EmptyState() {
    return <section className="rounded-xl border border-blue-200 bg-blue-50 p-6 text-blue-900"><h2 className="font-semibold">Waiting for the first analyser run</h2><p className="mt-2 text-sm">Enable the Supabase block in the analyser configuration and provide the three server-side environment variables. The Python worker will publish its next daily, weekly or monthly result here.</p></section>;
}

function Summary({ label, value, helper, tone }: { label: string; value: string; helper: string; tone?: "good" | "warn" }) {
    const color = tone === "good" ? "text-emerald-700" : tone === "warn" ? "text-amber-700" : "text-slate-950";
    return <div className="rounded-xl border border-slate-200 bg-white p-5"><p className="text-sm font-medium text-slate-500">{label}</p><p className={`mt-2 text-2xl font-bold ${color}`}>{value}</p><p className="mt-1 text-sm text-slate-500">{helper}</p></div>;
}

function NumberCell({ value }: { value: unknown }) {
    return <td className="px-4 py-3 text-right tabular-nums">{value === null ? "N/A" : number(value).toFixed(1)}</td>;
}

function ValuationCell({ score }: { score: MarketScore }) {
    return <td className="px-4 py-3">
        <p className="font-medium tabular-nums">{score.valuation_score === null ? "N/A" : number(score.valuation_score).toFixed(1)}</p>
        <p className="max-w-52 text-xs text-slate-500">{score.valuation_method ?? "No comparable valuation input"}</p>
        {score.valuation_source ? <p className="max-w-52 text-[11px] text-slate-400">{score.valuation_source.replaceAll("_", " ")}{score.valuation_as_of ? ` · ${score.valuation_as_of}` : ""}</p> : null}
    </td>;
}

function DeltaCell({ value }: { value: unknown }) {
    if (value === null) return <td className="px-4 py-3 text-right text-slate-400">N/A</td>;
    const delta = number(value);
    const color = delta > 0 ? "text-emerald-700" : delta < 0 ? "text-red-700" : "text-slate-500";
    return <td className={`px-4 py-3 text-right font-medium tabular-nums ${color}`}>{delta > 0 ? "+" : ""}{delta.toFixed(1)}</td>;
}

function SignalBadge({ action, actionable }: { action: string; actionable: boolean }) {
    const classes = !actionable ? "bg-slate-100 text-slate-600" : action === "INCREASE" || action === "OVERWEIGHT" ? "bg-emerald-50 text-emerald-700" : action === "REDUCE" || action === "AVOID_NEW_MONEY" ? "bg-red-50 text-red-700" : "bg-blue-50 text-blue-700";
    return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${classes}`}>{actionable ? action : "NO RECOMMENDATION"}</span>;
}
