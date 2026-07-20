import { redirect } from "next/navigation";
import { AlertTriangle, CheckCircle2, Clock3 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { StatusBanner } from "@/components/status-banner";
import { FormSubmitButton } from "@/components/form-submit-button";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { calculateSwingPerformance, calculateSwingQuantity } from "@/lib/swing";
import { getIndiaDate } from "@/lib/performance";
import {
    confirmSwingEntry,
    confirmSwingExit,
    saveSwingSettings,
    skipSwingCandidate,
    updateSwingStop,
} from "./actions";

type SearchParams = Promise<{ success?: string; error?: string }>;
type Settings = {
    trading_capital_inr: number | string;
    risk_per_trade_percentage: number | string;
    max_open_positions: number;
    max_sector_positions: number;
    minimum_setup_score: number | string;
    paper_mode: boolean;
};
type Scan = {
    id: string; as_of: string; status: string; model_version: string; market_regime: string;
    benchmark_symbol: string | null; benchmark_close: number | string | null;
    breadth_percentage: number | string | null; universe_size: number; eligible_size: number; data_issues: unknown;
};
type Candidate = {
    id: string; signal_key: string; symbol: string; company_name: string; sector: string | null;
    setup_type: string; status: string; setup_score: number | string; setup_as_of: string; expires_on: string;
    market_regime: string; close_price: number | string; entry_trigger: number | string;
    maximum_entry: number | string; initial_stop: number | string; atr: number | string;
    risk_per_share: number | string; reward_risk_ratio: number | string | null;
    suggested_quantity: number; suggested_risk_inr: number | string; last_price: number | string | null;
    last_price_as_of: string | null; score_components: unknown; reasons: unknown; invalidation_reason: string | null;
};
type Trade = {
    id: string; candidate_id: string | null; symbol: string; company_name: string; sector: string | null;
    trade_mode: "paper" | "live"; status: "open" | "exit_pending" | "closed";
    signal_entry: number | string; maximum_entry: number | string; entry_date: string;
    entry_price: number | string; quantity: number; initial_stop: number | string; current_stop: number | string;
    initial_risk_per_share: number | string; planned_risk_inr: number | string;
    current_price: number | string | null; current_price_as_of: string | null;
    highest_close: number | string | null; unrealized_pnl_inr: number | string | null;
    unrealized_r_multiple: number | string | null; exit_signal_reason: string | null;
    exit_signal_at: string | null; exit_date: string | null; exit_price: number | string | null;
    fees_inr: number | string; realized_pnl_inr: number | string | null;
    realized_r_multiple: number | string | null; notes: string | null;
};

const defaults: Settings = {
    trading_capital_inr: 100000,
    risk_per_trade_percentage: 0.5,
    max_open_positions: 5,
    max_sector_positions: 2,
    minimum_setup_score: 70,
    paper_mode: true,
};

function num(value: unknown) {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: unknown) {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(num(value));
}

function decimalMoney(value: unknown) {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num(value));
}

function signed(value: unknown, suffix = "") {
    const number = num(value);
    return `${number > 0 ? "+" : ""}${number.toFixed(2)}${suffix}`;
}

function date(value: string | null | undefined) {
    if (!value) return "—";
    return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
}

function dateTime(value: string | null | undefined) {
    if (!value) return "Never";
    return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(value));
}

function stringList(value: unknown) {
    return Array.isArray(value) ? value.map(String) : [];
}

function issueList(value: unknown) {
    if (!Array.isArray(value)) return [];
    return value.map((item) => {
        if (typeof item === "object" && item !== null) {
            const record = item as Record<string, unknown>;
            return `${String(record.source ?? "Data")}: ${String(record.message ?? "Unknown issue")}`;
        }
        return String(item);
    });
}

export default async function SwingLabPage({ searchParams }: { searchParams: SearchParams }) {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) redirect("/auth/login");

    const [settingsResult, scanResult, candidatesResult, tradesResult] = await Promise.all([
        supabase.from("swing_lab_settings").select("trading_capital_inr, risk_per_trade_percentage, max_open_positions, max_sector_positions, minimum_setup_score, paper_mode").eq("user_id", user.id).maybeSingle(),
        supabase.from("swing_scan_runs").select("id, as_of, status, model_version, market_regime, benchmark_symbol, benchmark_close, breadth_percentage, universe_size, eligible_size, data_issues").eq("user_id", user.id).order("as_of", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("swing_candidates").select("id, signal_key, symbol, company_name, sector, setup_type, status, setup_score, setup_as_of, expires_on, market_regime, close_price, entry_trigger, maximum_entry, initial_stop, atr, risk_per_share, reward_risk_ratio, suggested_quantity, suggested_risk_inr, last_price, last_price_as_of, score_components, reasons, invalidation_reason").eq("user_id", user.id).order("setup_as_of", { ascending: false }).limit(100),
        supabase.from("swing_trades").select("id, candidate_id, symbol, company_name, sector, trade_mode, status, signal_entry, maximum_entry, entry_date, entry_price, quantity, initial_stop, current_stop, initial_risk_per_share, planned_risk_inr, current_price, current_price_as_of, highest_close, unrealized_pnl_inr, unrealized_r_multiple, exit_signal_reason, exit_signal_at, exit_date, exit_price, fees_inr, realized_pnl_inr, realized_r_multiple, notes").eq("user_id", user.id).order("entry_date", { ascending: false }).limit(200),
    ]);
    const params = await searchParams;
    const queryError = settingsResult.error || scanResult.error || candidatesResult.error || tradesResult.error;
    if (queryError) {
        return <main className="mx-auto max-w-5xl px-4 py-8"><div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-5 text-red-800"><h1 className="font-semibold">Swing Lab migration required</h1><p className="mt-2 text-sm">{queryError.message}</p><p className="mt-2 text-xs">Apply <code>202607200003_swing_lab.sql</code> in Supabase, then reload this page.</p></div></main>;
    }

    const settings = (settingsResult.data ?? defaults) as Settings;
    const latestScan = scanResult.data as Scan | null;
    const candidates = (candidatesResult.data ?? []) as Candidate[];
    const trades = (tradesResult.data ?? []) as Trade[];
    const activeCandidates = candidates
        .filter((candidate) => ["candidate", "ready", "triggered"].includes(candidate.status))
        .sort((left, right) => (right.status === "triggered" ? 1 : 0) - (left.status === "triggered" ? 1 : 0) || num(right.setup_score) - num(left.setup_score));
    const inactiveCandidates = candidates.filter((candidate) => ["skipped", "expired", "invalidated"].includes(candidate.status)).slice(0, 12);
    const openTrades = trades.filter((trade) => trade.status !== "closed");
    const closedTrades = trades.filter((trade) => trade.status === "closed").slice(0, 30);
    const metrics = calculateSwingPerformance(trades.map((trade) => ({
        status: trade.status,
        entryPrice: num(trade.entry_price),
        quantity: trade.quantity,
        currentStop: num(trade.current_stop),
        realizedPnlInr: trade.realized_pnl_inr === null ? null : num(trade.realized_pnl_inr),
        realizedRMultiple: trade.realized_r_multiple === null ? null : num(trade.realized_r_multiple),
        exitDate: trade.exit_date,
    })));
    const scanIssues = issueList(latestScan?.data_issues);

    return <main><div className="mx-auto max-w-7xl px-4 py-8">
        <PageHeader title="Swing Lab" description="End-of-day Indian equity candidates, manually confirmed entries, protective stops, exit signals, and a separate swing-trade journal." />
        <StatusBanner success={params.success} error={params.error} />

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <Summary label="Trading capital" value={money(settings.trading_capital_inr)} helper={settings.paper_mode ? "Paper mode" : "Live mode"} />
            <Summary label="Open positions" value={`${openTrades.length}/${settings.max_open_positions}`} helper={`${money(metrics.openCapitalInr)} deployed`} />
            <Summary label="Open risk" value={money(metrics.openRiskInr)} helper="Entry minus current stop" tone={metrics.openRiskInr > 0 ? "warn" : undefined} />
            <Summary label="Realized P&L" value={money(metrics.totalRealizedPnlInr)} helper={`${metrics.closedTrades} closed trades`} tone={metrics.totalRealizedPnlInr > 0 ? "good" : metrics.totalRealizedPnlInr < 0 ? "bad" : undefined} />
            <Summary label="Average expectancy" value={metrics.averageRMultiple === null ? "Not enough data" : signed(metrics.averageRMultiple, "R")} helper={metrics.winRatePercentage === null ? "No closed trades" : `${metrics.winRatePercentage.toFixed(0)}% win rate`} tone={metrics.averageRMultiple === null ? undefined : metrics.averageRMultiple > 0 ? "good" : "bad"} />
        </section>

        <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div><h2 className="text-lg font-semibold">Latest end-of-day scan</h2><p className="mt-1 text-sm text-slate-500">Candidates are research priorities. A trade starts only after you confirm the actual fill.</p></div>
                {latestScan ? <RegimeBadge regime={latestScan.market_regime} /> : null}
            </div>
            {latestScan ? <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <SmallMetric label="As of" value={dateTime(latestScan.as_of)} />
                <SmallMetric label="Benchmark" value={`${latestScan.benchmark_symbol ?? "Nifty"} ${num(latestScan.benchmark_close).toFixed(0)}`} />
                <SmallMetric label="Breadth" value={latestScan.breadth_percentage === null ? "N/A" : `${num(latestScan.breadth_percentage).toFixed(0)}%`} />
                <SmallMetric label="Universe" value={String(latestScan.universe_size)} />
                <SmallMetric label="Passed gates" value={String(latestScan.eligible_size)} />
            </div> : <p className="mt-4 rounded-lg bg-blue-50 p-4 text-sm text-blue-800">The migration is ready, but no analyzer swing scan has been published yet. Run the updated analyzer after applying the migration.</p>}
            {scanIssues.length > 0 ? <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800"><p className="font-semibold">Scan data limitations</p><ul className="mt-2 space-y-1">{scanIssues.map((issue) => <li key={issue}>• {issue}</li>)}</ul></div> : null}
        </section>

        <section className="mt-6">
            <div className="flex items-end justify-between gap-4"><div><h2 className="text-xl font-semibold">Actionable candidates</h2><p className="mt-1 text-sm text-slate-500">Review the conditional entry, maximum acceptable price, stop and expiry before acting.</p></div><span className="text-sm text-slate-500">{activeCandidates.length} active</span></div>
            {activeCandidates.length ? <div className="mt-4 grid gap-4 xl:grid-cols-2">{activeCandidates.map((candidate) => <CandidateCard key={candidate.id} candidate={candidate} settings={settings} today={getIndiaDate()} />)}</div> : <div className="mt-4 rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">No active candidates. “No trade” is expected when the hard gates or setup quality are not satisfied.</div>}
        </section>

        <section className="mt-8">
            <div><h2 className="text-xl font-semibold">Open positions</h2><p className="mt-1 text-sm text-slate-500">Analyzer prices and stops are indicative until you confirm the real exit from your broker.</p></div>
            {openTrades.length ? <div className="mt-4 grid gap-4 xl:grid-cols-2">{openTrades.map((trade) => <OpenTradeCard key={trade.id} trade={trade} today={getIndiaDate()} />)}</div> : <div className="mt-4 rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">No confirmed paper or live positions.</div>}
        </section>

        <section className="mt-8 overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-5 py-4"><h2 className="text-lg font-semibold">Closed-trade journal</h2><p className="mt-1 text-sm text-slate-500">Use R-multiples and expectancy to judge the system after a meaningful sample, not one outcome.</p></div>
            {closedTrades.length ? <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><caption className="sr-only">Closed swing trades and realized performance</caption><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-5 py-3">Stock</th><th className="px-5 py-3">Mode</th><th className="px-5 py-3">Entry / exit</th><th className="px-5 py-3 text-right">Quantity</th><th className="px-5 py-3 text-right">Realized P&L</th><th className="px-5 py-3 text-right">Result</th><th className="px-5 py-3">Exit date</th></tr></thead><tbody className="divide-y divide-slate-100">{closedTrades.map((trade) => <tr key={trade.id}><td className="px-5 py-4"><p className="font-semibold">{trade.symbol}</p><p className="text-xs text-slate-500">{trade.company_name}</p></td><td className="px-5 py-4 uppercase">{trade.trade_mode}</td><td className="px-5 py-4">{decimalMoney(trade.entry_price)} → {decimalMoney(trade.exit_price)}</td><td className="px-5 py-4 text-right">{trade.quantity}</td><ToneCell value={num(trade.realized_pnl_inr)} text={money(trade.realized_pnl_inr)} /><ToneCell value={num(trade.realized_r_multiple)} text={signed(trade.realized_r_multiple, "R")} /><td className="px-5 py-4">{date(trade.exit_date)}</td></tr>)}</tbody></table></div> : <p className="p-5 text-sm text-slate-500">Closed trades will appear here.</p>}
            {metrics.closedTrades > 0 ? <div className="grid gap-3 border-t border-slate-100 p-5 sm:grid-cols-2 lg:grid-cols-4"><SmallMetric label="Profit factor" value={metrics.profitFactor === null ? "N/A" : Number.isFinite(metrics.profitFactor) ? metrics.profitFactor.toFixed(2) : "∞"} /><SmallMetric label="Maximum drawdown" value={money(metrics.maximumDrawdownInr)} /><SmallMetric label="Winning trades" value={String(metrics.winningTrades)} /><SmallMetric label="Losing trades" value={String(metrics.losingTrades)} /></div> : null}
        </section>

        {inactiveCandidates.length > 0 ? <details className="mt-6 rounded-xl border border-slate-200 bg-white p-5"><summary className="cursor-pointer font-semibold">Recently skipped, expired or invalidated candidates</summary><div className="mt-4 space-y-2">{inactiveCandidates.map((candidate) => <div key={candidate.id} className="flex flex-col gap-1 rounded-lg bg-slate-50 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"><span><strong>{candidate.symbol}</strong> · {candidate.status}</span><span className="text-slate-500">{candidate.invalidation_reason ?? `Score ${num(candidate.setup_score).toFixed(0)}`}</span></div>)}</div></details> : null}

        <section className="mt-8 rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-lg font-semibold">Swing Lab risk settings</h2>
            <p className="mt-1 text-sm text-slate-500">These settings control suggested quantities and analyzer candidate gates. Start in paper mode.</p>
            <form action={saveSwingSettings} className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <NumberField name="trading_capital_inr" label="Trading capital (INR)" value={num(settings.trading_capital_inr)} min={0} step={1000} />
                <NumberField name="risk_per_trade_percentage" label="Risk per trade (%)" value={num(settings.risk_per_trade_percentage)} min={0.1} max={5} step={0.1} />
                <NumberField name="minimum_setup_score" label="Minimum setup score" value={num(settings.minimum_setup_score)} min={0} max={100} step={1} />
                <NumberField name="max_open_positions" label="Maximum open positions" value={settings.max_open_positions} min={1} max={20} step={1} />
                <NumberField name="max_sector_positions" label="Maximum positions per sector" value={settings.max_sector_positions} min={1} max={10} step={1} />
                <label className="flex items-center gap-3 rounded-lg border border-slate-200 p-3 text-sm font-medium text-slate-700"><input type="checkbox" name="paper_mode" defaultChecked={settings.paper_mode} className="h-4 w-4" />Paper-trading mode</label>
                <div className="sm:col-span-2 lg:col-span-3"><FormSubmitButton pendingText="Saving risk settings...">Save risk settings</FormSubmitButton></div>
            </form>
        </section>
    </div></main>;
}

function CandidateCard({ candidate, settings, today }: { candidate: Candidate; settings: Settings; today: string }) {
    const suggestedQuantity = candidate.suggested_quantity || calculateSwingQuantity({
        tradingCapitalInr: num(settings.trading_capital_inr),
        riskPerTradePercentage: num(settings.risk_per_trade_percentage),
        entryPrice: num(candidate.entry_trigger),
        initialStop: num(candidate.initial_stop),
        maxOpenPositions: settings.max_open_positions,
    });
    const risk = Math.max(num(candidate.entry_trigger) - num(candidate.initial_stop), 0) * suggestedQuantity;
    const triggered = candidate.status === "triggered";
    return <article className={`rounded-xl border bg-white p-5 ${triggered ? "border-emerald-300 ring-1 ring-emerald-100" : "border-slate-200"}`}>
        <div className="flex items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-bold">{candidate.symbol}</h3><span className={`rounded-full px-2.5 py-1 text-xs font-semibold uppercase ${triggered ? "bg-emerald-50 text-emerald-700" : "bg-blue-50 text-blue-700"}`}>{candidate.status}</span></div><p className="mt-1 text-sm text-slate-600">{candidate.company_name}</p><p className="mt-1 text-xs text-slate-400">{candidate.sector || "Sector unavailable"} · expires {date(candidate.expires_on)}</p></div><div className="text-right"><p className="text-xs uppercase tracking-wide text-slate-400">Setup score</p><p className="mt-1 text-2xl font-bold text-blue-700">{num(candidate.setup_score).toFixed(0)}</p></div></div>
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4"><SmallMetric label="Entry above" value={decimalMoney(candidate.entry_trigger)} /><SmallMetric label="Maximum entry" value={decimalMoney(candidate.maximum_entry)} /><SmallMetric label="Initial stop" value={decimalMoney(candidate.initial_stop)} /><SmallMetric label="Suggested" value={`${suggestedQuantity} shares`} /></div>
        <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600"><p><strong>Planned risk:</strong> {money(risk)} · <strong>Risk/share:</strong> {decimalMoney(candidate.risk_per_share)} · <strong>Indicative R:R:</strong> {candidate.reward_risk_ratio === null ? "N/A" : `${num(candidate.reward_risk_ratio).toFixed(1)}×`}</p>{stringList(candidate.reasons).length ? <ul className="mt-2 space-y-1 text-xs">{stringList(candidate.reasons).map((reason) => <li key={reason}>• {reason}</li>)}</ul> : null}</div>
        <details className="mt-4 rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer text-sm font-semibold">Confirm that I entered this trade</summary><form action={confirmSwingEntry} className="mt-4 grid gap-3 sm:grid-cols-2"><input type="hidden" name="candidate_id" value={candidate.id} /><NumberField name="entry_price" label="Actual fill price" value={num(candidate.entry_trigger)} min={0.01} step={0.01} /><NumberField name="quantity" label="Actual quantity" value={suggestedQuantity} min={1} step={1} /><DateField name="entry_date" label="Entry date" value={today} /><label className="block text-sm font-medium text-slate-700">Trade mode<select name="trade_mode" defaultValue={settings.paper_mode ? "paper" : "live"} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2"><option value="paper">Paper</option><option value="live">Live</option></select></label><label className="block text-sm font-medium text-slate-700 sm:col-span-2">Note<input name="notes" placeholder="Optional entry note" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" /></label><div className="sm:col-span-2"><FormSubmitButton pendingText="Confirming entry...">Start tracking actual entry</FormSubmitButton></div></form></details>
        <form action={skipSwingCandidate} className="mt-3 flex flex-col gap-2 sm:flex-row"><input type="hidden" name="candidate_id" value={candidate.id} /><input name="reason" placeholder="Optional skip reason" className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm" /><ConfirmSubmitButton confirmation={`Skip ${candidate.symbol}?`} pendingText="Skipping...">Skip candidate</ConfirmSubmitButton></form>
    </article>;
}

function OpenTradeCard({ trade, today }: { trade: Trade; today: string }) {
    const current = trade.current_price === null ? num(trade.entry_price) : num(trade.current_price);
    const pnl = trade.unrealized_pnl_inr === null ? (current - num(trade.entry_price)) * trade.quantity : num(trade.unrealized_pnl_inr);
    const r = trade.unrealized_r_multiple === null ? pnl / Math.max(num(trade.planned_risk_inr), 0.01) : num(trade.unrealized_r_multiple);
    return <article className={`rounded-xl border bg-white p-5 ${trade.status === "exit_pending" ? "border-red-300 ring-1 ring-red-100" : "border-slate-200"}`}>
        <div className="flex items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-bold">{trade.symbol}</h3><span className={`rounded-full px-2.5 py-1 text-xs font-semibold uppercase ${trade.status === "exit_pending" ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>{trade.status.replace("_", " ")}</span><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium uppercase text-slate-600">{trade.trade_mode}</span></div><p className="mt-1 text-sm text-slate-600">{trade.quantity} shares · entered {date(trade.entry_date)}</p></div><div className="text-right"><p className={`text-xl font-bold ${pnl > 0 ? "text-emerald-700" : pnl < 0 ? "text-red-700" : "text-slate-950"}`}>{money(pnl)}</p><p className="text-xs font-medium text-slate-500">{signed(r, "R")}</p></div></div>
        {trade.status === "exit_pending" ? <div className="mt-4 flex gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><div><p className="font-semibold">Exit action pending</p><p>{trade.exit_signal_reason ?? "A strategy exit condition was reached."}</p></div></div> : null}
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4"><SmallMetric label="Entry" value={decimalMoney(trade.entry_price)} /><SmallMetric label="Current" value={decimalMoney(current)} /><SmallMetric label="Protective stop" value={decimalMoney(trade.current_stop)} /><SmallMetric label="Highest close" value={decimalMoney(trade.highest_close ?? trade.entry_price)} /></div>
        <p className="mt-3 text-xs text-slate-400">Price as of {date(trade.current_price_as_of)}. A gap through the stop may fill below the displayed stop.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <details className="rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer text-sm font-semibold">Raise stop manually</summary><form action={updateSwingStop} className="mt-3 space-y-3"><input type="hidden" name="trade_id" value={trade.id} /><NumberField name="new_stop" label="New stop" value={num(trade.current_stop)} min={num(trade.current_stop)} step={0.01} /><input name="reason" placeholder="Reason" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" /><FormSubmitButton pendingText="Updating stop...">Update stop</FormSubmitButton></form></details>
            <details className="rounded-lg border border-slate-200 p-3" open={trade.status === "exit_pending"}><summary className="cursor-pointer text-sm font-semibold">Confirm actual exit</summary><form action={confirmSwingExit} className="mt-3 space-y-3"><input type="hidden" name="trade_id" value={trade.id} /><DateField name="exit_date" label="Exit date" value={today} /><NumberField name="exit_price" label="Actual exit price" value={current} min={0.01} step={0.01} /><NumberField name="fees_inr" label="Total trade fees" value={0} min={0} step={0.01} /><input name="notes" placeholder="Optional exit note" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" /><ConfirmSubmitButton confirmation={`Close ${trade.symbol} using this actual exit?`} pendingText="Closing trade..." className="w-full bg-red-600 text-white hover:bg-red-700">Confirm exit</ConfirmSubmitButton></form></details>
        </div>
    </article>;
}

function Summary({ label, value, helper, tone }: { label: string; value: string; helper: string; tone?: "good" | "bad" | "warn" }) {
    const color = tone === "good" ? "text-emerald-700" : tone === "bad" ? "text-red-700" : tone === "warn" ? "text-amber-700" : "text-slate-950";
    return <div className="rounded-xl border border-slate-200 bg-white p-5"><p className="text-sm font-medium text-slate-500">{label}</p><p className={`mt-2 text-2xl font-bold ${color}`}>{value}</p><p className="mt-1 text-sm text-slate-500">{helper}</p></div>;
}

function SmallMetric({ label, value }: { label: string; value: string }) {
    return <div className="rounded-lg bg-slate-50 p-3"><p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p><p className="mt-1 font-semibold text-slate-800">{value}</p></div>;
}

function RegimeBadge({ regime }: { regime: string }) {
    const style = regime === "GREEN" ? "bg-emerald-50 text-emerald-700" : regime === "RED" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700";
    const Icon = regime === "GREEN" ? CheckCircle2 : regime === "RED" ? AlertTriangle : Clock3;
    return <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold ${style}`}><Icon className="h-4 w-4" />{regime} regime</span>;
}

function NumberField({ name, label, value, min, max, step }: { name: string; label: string; value: number; min?: number; max?: number; step?: number }) {
    return <label className="block text-sm font-medium text-slate-700">{label}<input name={name} type="number" defaultValue={value} min={min} max={max} step={step} required className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 outline-none focus:ring-2 focus:ring-slate-300" /></label>;
}

function DateField({ name, label, value }: { name: string; label: string; value: string }) {
    return <label className="block text-sm font-medium text-slate-700">{label}<input name={name} type="date" defaultValue={value} required className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 outline-none focus:ring-2 focus:ring-slate-300" /></label>;
}

function ToneCell({ value, text }: { value: number; text: string }) {
    return <td className={`px-5 py-4 text-right font-semibold ${value > 0 ? "text-emerald-700" : value < 0 ? "text-red-700" : "text-slate-600"}`}>{text}</td>;
}
