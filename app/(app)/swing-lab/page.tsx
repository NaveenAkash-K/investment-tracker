import { redirect } from "next/navigation";
import { Activity, AlertTriangle, CheckCircle2, Clock3, KeyRound, Server, ShieldCheck, WalletCards } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { StatusBanner } from "@/components/status-banner";
import { FormSubmitButton } from "@/components/form-submit-button";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { AnalyzerContractStatus } from "@/components/analyzer-contract-status";
import { AnalyzerDeliveryAlerts, type AnalyzerDelivery } from "@/components/analyzer-delivery-alerts";
import { isUsableSwingScan } from "@/lib/analyzer-contract";
import { calculateSwingExecutionQuality, calculateSwingPerformance, calculateSwingQuantity } from "@/lib/swing";
import { getIndiaDate, getLatestExpectedWeekdayRunDate } from "@/lib/performance";
import { getKiteConfigurationState } from "@/lib/kite/config";
import { maskBrokerUserId } from "@/lib/kite/session";
import {
    confirmSwingEntry,
    confirmSwingExit,
    configureSwingPaperAuto,
    disconnectKiteAccount,
    reconcileSwingCorporateAction,
    saveSwingSettings,
    skipSwingCandidate,
    updateSwingStop,
} from "./actions";
import { resolveAnalyzerDelivery } from "../analyzer-deliveries/actions";

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
    id: string; as_of: string; status: string; model_version: string; contract_version: string | null; publication_status: string | null; market_regime: string;
    raw_market_regime: string; regime_confirmed: boolean; regime_reason: string | null;
    regime_confirmation_reason: string | null;
    benchmark_symbol: string | null; benchmark_close: number | string | null;
    benchmark_sma50: number | string | null; benchmark_sma200: number | string | null;
    benchmark_distance_200_percentage: number | string | null; benchmark_price_date: string | null;
    expected_price_session: string | null; session_matches_expected: boolean; session_state: string;
    breadth_percentage: number | string | null; breadth_available: number; breadth_coverage_percentage: number | string | null;
    universe_size: number; eligible_size: number; published_size: number;
    effective_minimum_score: number | string | null; effective_risk_percentage: number | string | null;
    scan_blocked_reason: string | null; gate_counts: unknown; data_issues: unknown;
};
type Candidate = {
    id: string; scan_id: string; signal_key: string; symbol: string; company_name: string; sector: string | null;
    setup_type: string; status: string; setup_score: number | string; setup_as_of: string; expires_on: string;
    market_regime: string; close_price: number | string; entry_trigger: number | string;
    maximum_entry: number | string; initial_stop: number | string; atr: number | string;
    risk_per_share: number | string;
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
    corporate_action_review_required: boolean; corporate_action_reason: string | null;
    execution_source: "manual" | "paper_auto" | "assisted_live" | "live_auto";
    entry_slippage_inr: number | string; exit_slippage_inr: number | string;
    execution_cost_model: string | null; last_quote_at: string | null;
};
type MonitorRun = {
    id: string; as_of: string; status: string; contract_version: string | null; price_observed_at: string | null;
    candidates_requested: number; positions_requested: number;
    candidates_evaluated: number; positions_evaluated: number;
    candidates_checked: number; positions_checked: number; notification_count: number;
    failed_candidate_ids: unknown; failed_trade_ids: unknown; data_issues: unknown;
};
type TradeEvent = {
    trade_id: string;
    event_at: string;
    price: number | string | null;
    stop_price: number | string | null;
};
type KiteConnection = {
    connection_status: "disconnected" | "connected" | "expired" | "error";
    broker_user_id: string | null;
    user_name: string | null;
    connected_at: string | null;
    last_validated_at: string | null;
    session_expires_at: string | null;
    disconnected_at: string | null;
    error_message: string | null;
    has_active_session: boolean;
};
type KiteWorkerHeartbeat = {
    worker_id: string;
    worker_version: string;
    observed_public_ip: string | null;
    worker_status: "starting" | "healthy" | "degraded" | "blocked" | "stopping";
    execution_mode: "observe" | "paper_auto" | "assisted_live" | "live_auto";
    kite_session_healthy: boolean;
    quote_stream_healthy: boolean;
    reconciliation_healthy: boolean;
    heartbeat_at: string;
    details: unknown;
};
type KiteAccountSnapshot = {
    observed_at: string;
    account_status: "healthy" | "degraded" | "blocked" | "error";
    available_cash: number | string | null;
    utilised_debits: number | string | null;
    net_equity: number | string | null;
    holdings_count: number;
    positions_count: number;
    orders_count: number;
    trades_count: number;
};
type KiteReconciliationRun = {
    id: string;
    reconciliation_status: "matched" | "mismatch" | "unavailable" | "error";
    tracker_positions: number;
    broker_positions: number;
    matched_positions: number;
    mismatch_positions: number;
    broker_only_positions: number;
    checked_at: string;
    details: unknown;
};
type KiteReconciliationRow = {
    reconciliation_run_id: string | null;
    symbol: string;
    reconciliation_status: "matched" | "mismatch" | "blocked" | "unavailable";
    tracker_quantity: number | null;
    broker_quantity: number | null;
    tracker_average_price: number | string | null;
    broker_average_price: number | string | null;
};
type AutomationControls = {
    automation_mode: "advisory" | "paper_auto" | "assisted_live" | "live_auto";
    new_entries_enabled: boolean;
    armed_nse_session: string | null;
    emergency_stop_active: boolean;
    paper_slippage_bps: number | string;
    paper_max_new_entries_per_day: number;
};
type PaperEvent = {
    id: string;
    event_type: "candidate_invalidated" | "entry_filled" | "entry_and_stop" | "stop_filled" | "signal_exit_filled" | "cycle_blocked";
    symbol: string;
    quantity: number | null;
    price: number | string | null;
    fees_inr: number | string;
    reason: string;
    observed_at: string;
};

const defaults: Settings = {
    trading_capital_inr: 100000,
    risk_per_trade_percentage: 0.5,
    max_open_positions: 2,
    max_sector_positions: 1,
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

function optionalMoney(value: unknown) {
    return value === null || value === undefined ? "Unavailable" : money(value);
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

function numberRecord(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {} as Record<string, number>;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, num(item)]));
}

const gateLabels: Record<string, string> = {
    blocked_by_red_regime: "Not evaluated: RED regime",
    blocked_by_unknown_regime: "Not evaluated: unverified regime",
    stale_or_missing_session: "Missing completed-session price",
    insufficient_history: "Insufficient price history",
    price_or_atr: "Price or volatility gate",
    liquidity: "Liquidity gate",
    trend_alignment: "Not above rising 50/200-day trend",
    sma50_not_rising: "50-day average not rising",
    relative_strength: "Did not outperform Nifty",
    recent_breakout: "No recent breakout",
    pullback_shape: "Pullback shape outside limits",
    risk_geometry: "Stop distance outside limits",
    score_below_minimum: "Setup score below minimum",
    quantity_zero: "Quantity rounded to zero",
    passed_all_gates: "Passed all stock gates",
    excluded_or_event_blackout: "Excluded or event blackout",
    already_active: "Already active",
    sector_limit: "Sector position limit",
    published_candidates: "Published candidates",
};

export default async function SwingLabPage({ searchParams }: { searchParams: SearchParams }) {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) redirect("/auth/login");

    const [settingsResult, scanResult, monitorResult, candidatesResult, tradesResult, tradeEventsResult, deliveriesResult, kiteConnectionResult, kiteWorkerResult, kiteAccountResult, kiteReconciliationResult, kiteReconciliationRowsResult, automationResult, paperWorkerResult, paperEventsResult] = await Promise.all([
        supabase.from("swing_lab_settings").select("trading_capital_inr, risk_per_trade_percentage, max_open_positions, max_sector_positions, minimum_setup_score, paper_mode").eq("user_id", user.id).maybeSingle(),
        supabase.from("swing_scan_runs").select("id, as_of, status, model_version, contract_version, publication_status, market_regime, raw_market_regime, regime_confirmed, regime_reason, regime_confirmation_reason, benchmark_symbol, benchmark_close, benchmark_sma50, benchmark_sma200, benchmark_distance_200_percentage, benchmark_price_date, expected_price_session, session_matches_expected, session_state, breadth_percentage, breadth_available, breadth_coverage_percentage, universe_size, eligible_size, published_size, effective_minimum_score, effective_risk_percentage, scan_blocked_reason, gate_counts, data_issues").eq("user_id", user.id).order("as_of", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("swing_monitor_runs").select("id, as_of, status, contract_version, price_observed_at, candidates_requested, positions_requested, candidates_evaluated, positions_evaluated, candidates_checked, positions_checked, notification_count, failed_candidate_ids, failed_trade_ids, data_issues").eq("user_id", user.id).order("as_of", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("swing_candidates").select("id, scan_id, signal_key, symbol, company_name, sector, setup_type, status, setup_score, setup_as_of, expires_on, market_regime, close_price, entry_trigger, maximum_entry, initial_stop, atr, risk_per_share, suggested_quantity, suggested_risk_inr, last_price, last_price_as_of, score_components, reasons, invalidation_reason").eq("user_id", user.id).order("setup_as_of", { ascending: false }).limit(100),
        supabase.from("swing_trades").select("id, candidate_id, symbol, company_name, sector, trade_mode, status, signal_entry, maximum_entry, entry_date, entry_price, quantity, initial_stop, current_stop, initial_risk_per_share, planned_risk_inr, current_price, current_price_as_of, highest_close, unrealized_pnl_inr, unrealized_r_multiple, exit_signal_reason, exit_signal_at, exit_date, exit_price, fees_inr, realized_pnl_inr, realized_r_multiple, notes, corporate_action_review_required, corporate_action_reason, execution_source, entry_slippage_inr, exit_slippage_inr, execution_cost_model, last_quote_at").eq("user_id", user.id).order("entry_date", { ascending: false }).limit(200),
        supabase.from("swing_trade_events").select("trade_id, event_at, price, stop_price").eq("user_id", user.id).eq("event_type", "exit_signaled").order("event_at", { ascending: false }).limit(500),
        supabase.from("analyzer_notification_deliveries").select("id, delivery_key, channel, status, attempt_count, claimed_at, last_attempt_at, error_message").eq("user_id", user.id).in("channel", ["swing-eod", "swing-monitor"]).in("status", ["claimed", "uncertain"]).order("claimed_at", { ascending: false }).limit(20),
        supabase.rpc("get_kite_connection_status"),
        supabase.from("swing_worker_heartbeats").select("worker_id, worker_version, observed_public_ip, worker_status, execution_mode, kite_session_healthy, quote_stream_healthy, reconciliation_healthy, heartbeat_at, details").eq("user_id", user.id).eq("execution_mode", "observe").order("heartbeat_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("swing_broker_account_snapshots").select("observed_at, account_status, available_cash, utilised_debits, net_equity, holdings_count, positions_count, orders_count, trades_count").eq("user_id", user.id).order("observed_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("swing_reconciliation_runs").select("id, reconciliation_status, tracker_positions, broker_positions, matched_positions, mismatch_positions, broker_only_positions, checked_at, details").eq("user_id", user.id).order("checked_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("swing_position_reconciliations").select("reconciliation_run_id, symbol, reconciliation_status, tracker_quantity, broker_quantity, tracker_average_price, broker_average_price").eq("user_id", user.id).order("checked_at", { ascending: false }).limit(100),
        supabase.from("swing_automation_controls").select("automation_mode, new_entries_enabled, armed_nse_session, emergency_stop_active, paper_slippage_bps, paper_max_new_entries_per_day").eq("user_id", user.id).maybeSingle(),
        supabase.from("swing_worker_heartbeats").select("worker_id, worker_version, observed_public_ip, worker_status, execution_mode, kite_session_healthy, quote_stream_healthy, reconciliation_healthy, heartbeat_at, details").eq("user_id", user.id).eq("execution_mode", "paper_auto").order("heartbeat_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("swing_paper_events").select("id, event_type, symbol, quantity, price, fees_inr, reason, observed_at").eq("user_id", user.id).order("observed_at", { ascending: false }).limit(20),
    ]);
    const params = await searchParams;
    const queryError = settingsResult.error || scanResult.error || monitorResult.error || candidatesResult.error || tradesResult.error || tradeEventsResult.error || deliveriesResult.error || kiteConnectionResult.error || kiteWorkerResult.error || kiteAccountResult.error || kiteReconciliationResult.error || kiteReconciliationRowsResult.error || automationResult.error || paperWorkerResult.error || paperEventsResult.error;
    if (queryError) {
        return <main className="mx-auto max-w-5xl px-4 py-8"><div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-5 text-red-800"><h1 className="font-semibold">Swing Lab migration required</h1><p className="mt-2 text-sm">{queryError.message}</p><p className="mt-2 text-xs">Apply all pending Supabase migrations through <code>202608020003_swing_paper_auto.sql</code>, then reload this page.</p></div></main>;
    }

    const settings = (settingsResult.data ?? defaults) as Settings;
    const latestScan = scanResult.data as Scan | null;
    const latestMonitor = monitorResult.data as MonitorRun | null;
    const deliveryRows = (deliveriesResult.data ?? []) as AnalyzerDelivery[];
    const kiteConnection = ((kiteConnectionResult.data ?? [])[0] ?? null) as KiteConnection | null;
    const kiteWorker = (kiteWorkerResult.data ?? null) as KiteWorkerHeartbeat | null;
    const kiteAccount = (kiteAccountResult.data ?? null) as KiteAccountSnapshot | null;
    const kiteReconciliation = (kiteReconciliationResult.data ?? null) as KiteReconciliationRun | null;
    const kiteReconciliationRows = ((kiteReconciliationRowsResult.data ?? []) as KiteReconciliationRow[])
        .filter((row) => row.reconciliation_run_id === kiteReconciliation?.id);
    const automation = (automationResult.data ?? {
        automation_mode: "advisory", new_entries_enabled: false,
        armed_nse_session: null, emergency_stop_active: false,
        paper_slippage_bps: 5, paper_max_new_entries_per_day: 1,
    }) as AutomationControls;
    const paperWorker = (paperWorkerResult.data ?? null) as KiteWorkerHeartbeat | null;
    const paperEvents = (paperEventsResult.data ?? []) as PaperEvent[];
    const kiteConfiguration = getKiteConfigurationState();
    const candidates = (candidatesResult.data ?? []) as Candidate[];
    const trades = (tradesResult.data ?? []) as Trade[];
    const latestExitEventByTrade = new Map<string, TradeEvent>();
    for (const event of (tradeEventsResult.data ?? []) as TradeEvent[]) {
        if (!latestExitEventByTrade.has(event.trade_id)) latestExitEventByTrade.set(event.trade_id, event);
    }
    const now = new Date();
    const kiteWorkerFresh = Boolean(
        kiteWorker
        && now.getTime() - new Date(kiteWorker.heartbeat_at).getTime() <= 10 * 60_000
        && (!kiteConnection?.connected_at || new Date(kiteWorker.heartbeat_at).getTime() >= new Date(kiteConnection.connected_at).getTime()),
    );
    const paperWorkerFresh = Boolean(
        paperWorker && now.getTime() - new Date(paperWorker.heartbeat_at).getTime() <= 10 * 60_000,
    );
    const currentIndiaDate = getIndiaDate(now);
    const paperAutoArmed = automation.automation_mode === "paper_auto"
        && automation.new_entries_enabled
        && automation.armed_nse_session === currentIndiaDate
        && !automation.emergency_stop_active;
    const activeCandidates = candidates
        .filter((candidate) => ["candidate", "ready", "triggered"].includes(candidate.status) && candidate.expires_on >= currentIndiaDate)
        .sort((left, right) => (right.status === "triggered" ? 1 : 0) - (left.status === "triggered" ? 1 : 0) || num(right.setup_score) - num(left.setup_score));
    const inactiveCandidates = candidates.filter((candidate) => ["skipped", "expired", "invalidated"].includes(candidate.status) || candidate.expires_on < currentIndiaDate).slice(0, 12);
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
    const execution = calculateSwingExecutionQuality(trades.map((trade) => {
        const exitEvent = latestExitEventByTrade.get(trade.id);
        return {
            tradeId: trade.id,
            signalEntry: num(trade.signal_entry),
            maximumEntry: num(trade.maximum_entry),
            entryPrice: num(trade.entry_price),
            initialStop: num(trade.initial_stop),
            quantity: trade.quantity,
            plannedRiskInr: num(trade.planned_risk_inr),
            feesInr: num(trade.fees_inr),
            exitPrice: trade.exit_price === null ? null : num(trade.exit_price),
            exitSignalPrice: exitEvent?.price === null || exitEvent?.price === undefined ? null : num(exitEvent.price),
            exitSignalStop: exitEvent?.stop_price === null || exitEvent?.stop_price === undefined ? null : num(exitEvent.stop_price),
        };
    }));
    const executionByTrade = new Map(execution.rows.map((row) => [row.tradeId, row]));
    const scanIssues = issueList(latestScan?.data_issues);
    const monitorIssues = issueList(latestMonitor?.data_issues);
    const failedMonitorRecords = [
        ...stringList(latestMonitor?.failed_candidate_ids).map((id) => `Candidate ${id}`),
        ...stringList(latestMonitor?.failed_trade_ids).map((id) => `Trade ${id}`),
    ];
    const gateEntries = Object.entries(numberRecord(latestScan?.gate_counts)).filter(([, count]) => count > 0);
    const slotCapital = num(settings.trading_capital_inr) / Math.max(settings.max_open_positions, 1);
    const riskBudget = num(settings.trading_capital_inr) * num(settings.risk_per_trade_percentage) / 100;
    const effectiveRiskPercentage = latestScan?.effective_risk_percentage === null || latestScan?.effective_risk_percentage === undefined
        ? num(settings.risk_per_trade_percentage)
        : num(latestScan.effective_risk_percentage);
    const effectiveRiskBudget = num(settings.trading_capital_inr) * effectiveRiskPercentage / 100;
    const expectedScanDate = getLatestExpectedWeekdayRunDate(17, 30, 90, now);
    const expectedMonitorDate = getLatestExpectedWeekdayRunDate(9, 25, 95, now);
    const scanHeartbeatMissed = !latestScan || getIndiaDate(new Date(latestScan.as_of)) < expectedScanDate;
    const monitorHeartbeatMissed = !latestMonitor || getIndiaDate(new Date(latestMonitor.as_of)) < expectedMonitorDate;
    const latestScanUsable = isUsableSwingScan(latestScan ? {
        status: latestScan.status,
        sessionState: latestScan.session_state,
        sessionMatchesExpected: latestScan.session_matches_expected,
        contractVersion: latestScan.contract_version,
        publicationStatus: latestScan.publication_status,
    } : null);
    const candidateEntryAllowed = latestScanUsable && !scanHeartbeatMissed;
    const candidateEntryBlockedReason = scanHeartbeatMissed
        ? "A fresh end-of-day scan has not been published for the expected workflow date."
        : !latestScanUsable
            ? "The latest scan is failed, stale, unpublished, or uses an unsupported contract."
            : null;

    return <main><div className="mx-auto max-w-7xl px-4 py-8">
        <PageHeader title="Swing Lab" description="End-of-day Indian equity candidates, manual trade tracking, and read-only Kite-powered Paper Auto simulation." />
        <StatusBanner success={params.success} error={params.error} />
        <AnalyzerDeliveryAlerts deliveries={deliveryRows} returnTo="/swing-lab" resolveAction={resolveAnalyzerDelivery} />
        {latestScan ? <AnalyzerContractStatus version={latestScan.contract_version} publisher="Swing scan" /> : null}
        {latestMonitor ? <AnalyzerContractStatus version={latestMonitor.contract_version} publisher="Swing monitor" /> : null}
        <KiteConnectionCard connection={kiteConnection} configured={kiteConfiguration.configured} worker={kiteWorker} workerFresh={kiteWorkerFresh} account={kiteAccount} reconciliation={kiteReconciliation} reconciliationRows={kiteReconciliationRows} />
        <PaperAutoCard controls={automation} worker={paperWorker} workerFresh={paperWorkerFresh} events={paperEvents} kiteConnected={Boolean(kiteConfiguration.configured && kiteConnection?.connection_status === "connected" && kiteConnection.has_active_session)} today={currentIndiaDate} />
        {scanHeartbeatMissed ? <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900"><p className="font-semibold">End-of-day scan heartbeat is missing</p><p className="mt-1">No scan was published for the latest expected workflow date, {date(expectedScanDate)}. Check the GitHub Action and Tracker publication logs.</p></div> : latestScan?.status === "failed" ? <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">The latest end-of-day scan failed. Do not treat older candidates as newly validated.</div> : null}
        {monitorHeartbeatMissed ? <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900"><p className="font-semibold">Morning monitor heartbeat is missing</p><p className="mt-1">No monitor was published for the latest expected workflow date, {date(expectedMonitorDate)}. Verify open positions directly with your broker until the job recovers.</p></div> : latestMonitor?.status === "failed" ? <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">The latest morning monitor failed. No requested record could be evaluated from fresh data; verify candidates and stops with your broker.</div> : latestMonitor?.status === "partial" ? <div role="alert" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">The latest morning monitor was partial. Only the explicitly evaluated records below received a fresh check.</div> : null}

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <Summary label="Trading capital" value={money(settings.trading_capital_inr)} helper={settings.paper_mode ? "Paper mode" : "Live mode"} />
            <Summary label="Open positions" value={`${openTrades.length}/${settings.max_open_positions}`} helper={`${money(metrics.openCapitalInr)} deployed`} />
            <Summary label="Open risk" value={money(metrics.openRiskInr)} helper="Entry minus current stop" tone={metrics.openRiskInr > 0 ? "warn" : undefined} />
            <Summary label="Realized P&L" value={money(metrics.totalRealizedPnlInr)} helper={`${metrics.closedTrades} closed trades`} tone={metrics.totalRealizedPnlInr > 0 ? "good" : metrics.totalRealizedPnlInr < 0 ? "bad" : undefined} />
            <Summary label="Average expectancy" value={metrics.averageRMultiple === null ? "Not enough data" : signed(metrics.averageRMultiple, "R")} helper={metrics.winRatePercentage === null ? "No closed trades" : `${metrics.winRatePercentage.toFixed(0)}% win rate`} tone={metrics.averageRMultiple === null ? undefined : metrics.averageRMultiple > 0 ? "good" : "bad"} />
        </section>

        <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div><h2 className="text-lg font-semibold">Latest end-of-day scan</h2><p className="mt-1 text-sm text-slate-500">Candidates are research priorities. Advisory mode waits for your confirmation; armed Paper Auto waits for an observed live trigger crossing.</p></div>
                {latestScan ? <RegimeBadge regime={latestScan.market_regime} /> : null}
            </div>
            {latestScan ? <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
                <SmallMetric label="As of" value={dateTime(latestScan.as_of)} />
                <SmallMetric label="Price session" value={date(latestScan.benchmark_price_date)} />
                <SmallMetric label="Expected session" value={date(latestScan.expected_price_session)} />
                <SmallMetric label="Nifty close" value={latestScan.benchmark_close === null ? "N/A" : num(latestScan.benchmark_close).toFixed(0)} />
                <SmallMetric label="50-day average" value={latestScan.benchmark_sma50 === null ? "N/A" : num(latestScan.benchmark_sma50).toFixed(0)} />
                <SmallMetric label="200-day average" value={latestScan.benchmark_sma200 === null ? "N/A" : num(latestScan.benchmark_sma200).toFixed(0)} />
                <SmallMetric label="Distance vs 200-day" value={latestScan.benchmark_distance_200_percentage === null ? "N/A" : signed(latestScan.benchmark_distance_200_percentage, "%")} />
                <SmallMetric label="Breadth above 50-day" value={latestScan.breadth_percentage === null ? "N/A" : `${num(latestScan.breadth_percentage).toFixed(0)}% (${latestScan.breadth_available}/${latestScan.universe_size})`} />
                <SmallMetric label="Universe" value={String(latestScan.universe_size)} />
            </div> : <p className="mt-4 rounded-lg bg-blue-50 p-4 text-sm text-blue-800">The migration is ready, but no analyzer swing scan has been published yet. Run the updated analyzer after applying the migration.</p>}
            {latestScan ? <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                <p className="font-semibold">Why this regime?</p>
                <p className="mt-1">{latestScan.regime_reason ?? "Regime evidence is unavailable."}</p>
                <p className="mt-1 text-xs text-slate-500">Raw reading: {latestScan.raw_market_regime}. {latestScan.regime_confirmation_reason ?? (latestScan.regime_confirmed ? "Confirmed using completed sessions." : "Awaiting confirmation.")}</p>
                <p className="mt-2 text-xs font-medium text-slate-600">Controls used: minimum score {latestScan.effective_minimum_score === null ? "N/A" : num(latestScan.effective_minimum_score).toFixed(0)} · risk {latestScan.effective_risk_percentage === null ? "N/A" : `${num(latestScan.effective_risk_percentage).toFixed(2)}%`} · {latestScan.eligible_size} passed · {latestScan.published_size} published</p>
            </div> : null}
            {latestScan?.scan_blocked_reason ? <div role="status" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p className="font-semibold">Candidate scan status</p><p className="mt-1">{latestScan.scan_blocked_reason}</p></div> : null}
            {latestScan && latestScan.session_state === "completed" && !latestScan.session_matches_expected ? <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900"><p className="font-semibold">Stale price session blocked</p><p className="mt-1">The analyzer did not publish actionable candidates because the provider session did not match the expected NSE session.</p></div> : null}
            {gateEntries.length > 0 ? <details className="mt-4 rounded-lg border border-slate-200 p-4"><summary className="cursor-pointer text-sm font-semibold">Candidate gate funnel</summary><div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{gateEntries.map(([key, count]) => <div key={key} className="flex items-center justify-between gap-3 rounded-md bg-slate-50 px-3 py-2 text-sm"><span className="text-slate-600">{gateLabels[key] ?? key.replaceAll("_", " ")}</span><strong>{count}</strong></div>)}</div><p className="mt-3 text-xs text-slate-500">Each stock is counted at its first failed gate. In RED or UNKNOWN, stock-level gates are deliberately not evaluated.</p></details> : null}
            {scanIssues.length > 0 ? <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800"><p className="font-semibold">Scan data limitations</p><ul className="mt-2 space-y-1">{scanIssues.map((issue) => <li key={issue}>• {issue}</li>)}</ul></div> : null}
        </section>

        <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div><h2 className="font-semibold">Morning monitor heartbeat</h2><p className="mt-1 text-sm text-slate-500">Confirms whether the scheduled candidate and protective-stop check actually published.</p></div>
                {latestMonitor ? <span className={`rounded-full px-3 py-1 text-xs font-semibold uppercase ${latestMonitor.status === "successful" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>{latestMonitor.status}</span> : null}
            </div>
            {latestMonitor ? <>
                <p className="mt-3 text-sm text-slate-600">Ran {dateTime(latestMonitor.as_of)} · price observed {dateTime(latestMonitor.price_observed_at)} · evaluated {latestMonitor.candidates_evaluated}/{latestMonitor.candidates_requested} candidates and {latestMonitor.positions_evaluated}/{latestMonitor.positions_requested} positions · {latestMonitor.notification_count} actions.</p>
                {failedMonitorRecords.length ? <p className="mt-2 text-xs text-amber-800">Not evaluated: {failedMonitorRecords.join(", ")}.</p> : null}
                {monitorIssues.length ? <ul className="mt-3 space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">{monitorIssues.map((issue) => <li key={issue}>• {issue}</li>)}</ul> : null}
            </> : <p className="mt-3 text-sm text-slate-500">No morning-monitor run has been published since the heartbeat migration was applied.</p>}
        </section>

        <section className="mt-6">
            <div className="flex items-end justify-between gap-4"><div><h2 className="text-xl font-semibold">{candidateEntryAllowed ? "Actionable candidates" : "Candidates for review"}</h2><p className="mt-1 text-sm text-slate-500">{candidateEntryAllowed ? "Review the conditional entry, maximum acceptable price, stop and expiry before acting." : "Older candidates remain visible for context, but entry confirmation is disabled until scan validity is restored."}</p></div><span className="text-sm text-slate-500">{activeCandidates.length} active</span></div>
            {candidateEntryBlockedReason ? <div role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p className="font-semibold">New entries are temporarily disabled</p><p className="mt-1">{candidateEntryBlockedReason}</p></div> : null}
            {paperAutoArmed ? <div role="status" className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900"><p className="font-semibold">Paper Auto is watching eligible candidates</p><p className="mt-1">Manual entry confirmation is disabled while armed to prevent duplicate tracking. No Kite order will be placed.</p></div> : null}
            {activeCandidates.length ? <div className="mt-4 grid gap-4 xl:grid-cols-2">{activeCandidates.map((candidate) => <CandidateCard key={candidate.id} candidate={candidate} settings={settings} today={currentIndiaDate} entryAllowed={candidateEntryAllowed && !paperAutoArmed} entryBlockedReason={paperAutoArmed ? "Paper Auto is armed and watching this candidate for a fresh live trigger crossing." : candidateEntryBlockedReason} carriedForward={Boolean(latestScan && candidate.scan_id !== latestScan.id)} />)}</div> : <div className="mt-4 rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">No active candidates. “No trade” is expected when the hard gates or setup quality are not satisfied.</div>}
        </section>

        <section className="mt-8">
            <div><h2 className="text-xl font-semibold">Open positions</h2><p className="mt-1 text-sm text-slate-500">Manual records use your confirmed broker fills. Paper Auto records simulated live-quote fills and never sends an order.</p></div>
            {openTrades.length ? <div className="mt-4 grid gap-4 xl:grid-cols-2">{openTrades.map((trade) => <OpenTradeCard key={trade.id} trade={trade} today={currentIndiaDate} />)}</div> : <div className="mt-4 rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">No confirmed paper or live positions.</div>}
        </section>

        <section className="mt-8 overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-5 py-4"><h2 className="text-lg font-semibold">Closed-trade journal</h2><p className="mt-1 text-sm text-slate-500">Use R-multiples and expectancy to judge the system after a meaningful sample, not one outcome.</p></div>
            {closedTrades.length ? <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><caption className="sr-only">Closed swing trades and realized performance</caption><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-5 py-3">Stock</th><th className="px-5 py-3">Mode</th><th className="px-5 py-3">Entry / exit</th><th className="px-5 py-3 text-right">Quantity</th><th className="px-5 py-3 text-right">Realized P&L</th><th className="px-5 py-3 text-right">Result</th><th className="px-5 py-3">Exit date</th></tr></thead><tbody className="divide-y divide-slate-100">{closedTrades.map((trade) => <tr key={trade.id}><td className="px-5 py-4"><p className="font-semibold">{trade.symbol}</p><p className="text-xs text-slate-500">{trade.company_name}</p></td><td className="px-5 py-4 uppercase"><p>{trade.trade_mode}</p><p className="text-xs text-slate-400">{trade.execution_source.replaceAll("_", " ")}</p></td><td className="px-5 py-4">{decimalMoney(trade.entry_price)} → {decimalMoney(trade.exit_price)}</td><td className="px-5 py-4 text-right">{trade.quantity}</td><ToneCell value={num(trade.realized_pnl_inr)} text={money(trade.realized_pnl_inr)} /><ToneCell value={num(trade.realized_r_multiple)} text={signed(trade.realized_r_multiple, "R")} /><td className="px-5 py-4">{date(trade.exit_date)}</td></tr>)}</tbody></table></div> : <p className="p-5 text-sm text-slate-500">Closed trades will appear here.</p>}
            {metrics.closedTrades > 0 ? <div className="grid gap-3 border-t border-slate-100 p-5 sm:grid-cols-2 lg:grid-cols-4"><SmallMetric label="Profit factor" value={metrics.profitFactor === null ? "N/A" : Number.isFinite(metrics.profitFactor) ? metrics.profitFactor.toFixed(2) : "∞"} /><SmallMetric label="Maximum drawdown" value={money(metrics.maximumDrawdownInr)} /><SmallMetric label="Winning trades" value={String(metrics.winningTrades)} /><SmallMetric label="Losing trades" value={String(metrics.losingTrades)} /></div> : null}
        </section>

        <section className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-5 py-4"><h2 className="text-lg font-semibold">Execution quality</h2><p className="mt-1 text-sm text-slate-500">Compares your confirmed fills with the signal, risk plan and recorded exit signal. Positive slippage is an execution cost; negative slippage is an improvement.</p></div>
            {trades.length ? <>
                <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-5"><SmallMetric label="Entry slippage" value={money(execution.totalEntrySlippageInr)} /><SmallMetric label="Exit slippage" value={execution.comparableExitCount ? money(execution.totalExitSlippageInr) : "Unavailable"} /><SmallMetric label="Fees" value={money(execution.totalFeesInr)} /><SmallMetric label="Risk above plan" value={money(execution.totalRiskVarianceInr)} /><SmallMetric label="Gap beyond stop" value={money(execution.totalStopGapInr)} /></div>
                <div className="overflow-x-auto border-t border-slate-100"><table className="w-full min-w-[1040px] text-left text-sm"><caption className="sr-only">Swing execution quality by confirmed trade</caption><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-5 py-3">Stock</th><th className="px-5 py-3 text-right">Entry slippage</th><th className="px-5 py-3 text-right">Actual / planned risk</th><th className="px-5 py-3 text-right">Fees</th><th className="px-5 py-3 text-right">Exit slippage</th><th className="px-5 py-3 text-right">Stop gap</th></tr></thead><tbody className="divide-y divide-slate-100">{trades.slice(0, 30).map((trade) => {
                    const row = executionByTrade.get(trade.id);
                    if (!row) return null;
                    return <tr key={trade.id}><td className="px-5 py-4"><p className="font-semibold">{trade.symbol}</p><p className="text-xs uppercase text-slate-400">{trade.trade_mode} · {trade.status.replace("_", " ")}</p></td><ExecutionToneCell value={row.entrySlippageInr} text={`${money(row.entrySlippageInr)} · ${row.entrySlippagePercentage?.toFixed(2) ?? "N/A"}%`} /><td className="px-5 py-4 text-right"><p>{money(row.actualInitialRiskInr)} / {money(trade.planned_risk_inr)}</p><p className={row.riskVarianceInr > 0 ? "text-xs text-red-600" : "text-xs text-emerald-600"}>{row.riskVarianceInr > 0 ? "+" : ""}{money(row.riskVarianceInr)}</p></td><td className="px-5 py-4 text-right"><p>{money(trade.fees_inr)}</p><p className="text-xs text-slate-400">{row.feesInR === null ? "R unavailable" : `${row.feesInR.toFixed(2)}R`}</p></td><ExecutionToneCell value={row.exitSlippageInr} text={row.exitSlippageInr === null ? "Unavailable" : money(row.exitSlippageInr)} /><ExecutionToneCell value={row.stopGapInr} text={row.stopGapInr === null ? "Unavailable" : money(row.stopGapInr)} /></tr>;
                })}</tbody></table></div>
            </> : <p className="p-5 text-sm text-slate-500">Execution metrics appear after you confirm a paper or live entry.</p>}
        </section>

        {inactiveCandidates.length > 0 ? <details className="mt-6 rounded-xl border border-slate-200 bg-white p-5"><summary className="cursor-pointer font-semibold">Recently skipped, expired or invalidated candidates</summary><div className="mt-4 space-y-2">{inactiveCandidates.map((candidate) => <div key={candidate.id} className="flex flex-col gap-1 rounded-lg bg-slate-50 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"><span><strong>{candidate.symbol}</strong> · {candidate.status}</span><span className="text-slate-500">{candidate.invalidation_reason ?? `Score ${num(candidate.setup_score).toFixed(0)}`}</span></div>)}</div></details> : null}

        <section className="mt-8 rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-lg font-semibold">Swing Lab risk settings</h2>
            <p className="mt-1 text-sm text-slate-500">These settings control suggested quantities and analyzer candidate gates. Start in paper mode.</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3"><SmallMetric label="Capital available per slot" value={money(slotCapital)} /><SmallMetric label="Configured risk budget" value={money(riskBudget)} /><SmallMetric label="Current regime risk budget" value={money(effectiveRiskBudget)} /></div>
            {num(settings.trading_capital_inr) <= 10000 && settings.max_open_positions > 2 ? <p role="alert" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">With {money(settings.trading_capital_inr)}, use at most two positions. More slots can cause otherwise valid stocks to receive a suggested quantity of zero.</p> : null}
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

function PaperAutoCard({ controls, worker, workerFresh, events, kiteConnected, today }: {
    controls: AutomationControls;
    worker: KiteWorkerHeartbeat | null;
    workerFresh: boolean;
    events: PaperEvent[];
    kiteConnected: boolean;
    today: string;
}) {
    const armed = controls.automation_mode === "paper_auto"
        && controls.new_entries_enabled
        && controls.armed_nse_session === today
        && !controls.emergency_stop_active;
    const paused = controls.automation_mode === "paper_auto" && !armed;
    const workerReady = Boolean(workerFresh && worker?.worker_status === "healthy" && worker.kite_session_healthy);
    const statusLabel = armed ? "Armed today" : paused ? "New entries paused" : "Advisory";
    const tone = armed
        ? "border-blue-200 bg-blue-50 text-blue-800"
        : paused
            ? "border-amber-200 bg-amber-50 text-amber-900"
            : "border-slate-200 bg-slate-50 text-slate-700";

    return <section className="mb-6 rounded-xl border border-slate-200 bg-white p-5" aria-labelledby="paper-auto-title">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex gap-3">
                <div className="rounded-lg bg-violet-50 p-2 text-violet-700"><Activity className="h-5 w-5" /></div>
                <div><h2 id="paper-auto-title" className="text-lg font-semibold">Paper Auto</h2><p className="mt-1 text-sm text-slate-500">Production Kite quotes, simulated fills, realistic costs and automated paper stops. Broker order execution remains impossible in Batch 3.</p></div>
            </div>
            <span role="status" className={`w-fit rounded-full border px-3 py-1 text-xs font-semibold uppercase ${tone}`}>{statusLabel}</span>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <SmallMetric label="Mode" value={statusLabel} />
            <SmallMetric label="Armed session" value={date(controls.armed_nse_session)} />
            <SmallMetric label="Paper worker" value={!worker ? "Not observed" : !workerFresh ? "Heartbeat stale" : worker.worker_status} />
            <SmallMetric label="Live quotes" value={!workerFresh ? "Unavailable" : worker?.quote_stream_healthy ? "Fresh" : "Idle / unavailable"} />
            <SmallMetric label="Broker orders" value="Blocked" />
        </div>

        {!kiteConnected ? <div role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p className="font-semibold">Connect Kite before arming</p><p className="mt-1">Paper Auto uses the same daily encrypted Kite session. It cannot be enabled with a missing or expired session.</p></div> : null}
        {controls.emergency_stop_active ? <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">The emergency stop is active. New Paper Auto entries are blocked.</div> : null}
        {armed && !workerReady ? <div role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p className="font-semibold">Armed, but worker readiness is not confirmed</p><p className="mt-1">No simulated entry can occur without a fresh Kite session and quote. Check the VPS service and its journal.</p></div> : null}

        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
            <p className="font-semibold">How a paper entry happens</p>
            <p className="mt-1">After 09:20 IST the worker must first observe a price below the trigger and then a real upward crossing within the maximum entry. It never invents a fill from an already-crossed first observation. Pausing blocks new entries but keeps monitoring existing Paper Auto stops and pending exits.</p>
        </div>

        <form action={configureSwingPaperAuto} className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <input type="hidden" name="action" value="enable" />
            <NumberField name="paper_slippage_bps" label="Adverse slippage (bps)" value={num(controls.paper_slippage_bps)} min={0} max={50} step={0.5} />
            <NumberField name="paper_max_new_entries_per_day" label="Maximum new paper entries/day" value={controls.paper_max_new_entries_per_day} min={1} max={5} step={1} />
            <div className="rounded-lg border border-slate-200 p-3 text-sm text-slate-600"><p className="font-medium text-slate-800">Cost model</p><p className="mt-1">NSE CNC statutory charges, DP charge and adverse fill slippage.</p></div>
            <div className="flex items-end"><ConfirmSubmitButton confirmation="Arm Paper Auto for today's session? This can create simulated paper trades, but no broker orders." pendingText="Arming Paper Auto..." className="w-full bg-violet-700 text-white hover:bg-violet-800" disabled={!kiteConnected}>{armed ? "Save and re-arm today" : "Arm Paper Auto today"}</ConfirmSubmitButton></div>
        </form>

        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
            {controls.automation_mode === "paper_auto" ? <form action={configureSwingPaperAuto}><input type="hidden" name="action" value="pause" /><input type="hidden" name="paper_slippage_bps" value={num(controls.paper_slippage_bps)} /><input type="hidden" name="paper_max_new_entries_per_day" value={controls.paper_max_new_entries_per_day} /><ConfirmSubmitButton confirmation="Pause only new Paper Auto entries? Existing simulated positions will keep their stop and exit monitoring." pendingText="Pausing entries...">Pause new entries</ConfirmSubmitButton></form> : null}
            {controls.automation_mode === "paper_auto" ? <form action={configureSwingPaperAuto}><input type="hidden" name="action" value="advisory" /><input type="hidden" name="paper_slippage_bps" value={num(controls.paper_slippage_bps)} /><input type="hidden" name="paper_max_new_entries_per_day" value={controls.paper_max_new_entries_per_day} /><ConfirmSubmitButton confirmation="Return new entries to manual Advisory mode? Existing paper records will remain in the journal." pendingText="Switching to Advisory...">Use Advisory mode</ConfirmSubmitButton></form> : null}
            <p className="flex items-center gap-2 text-xs text-slate-500"><ShieldCheck className="h-4 w-4 text-emerald-600" />No broker order, leverage, short sale or automatic live trade path exists.</p>
        </div>

        <details className="mt-4 rounded-lg border border-slate-200 p-4">
            <summary className="cursor-pointer text-sm font-semibold">Recent Paper Auto activity ({events.length})</summary>
            {events.length ? <div className="mt-3 space-y-2">{events.map((event) => <div key={event.id} className="rounded-lg bg-slate-50 p-3 text-sm"><div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between"><p><strong>{event.symbol}</strong> · {event.event_type.replaceAll("_", " ")}</p><span className="text-xs text-slate-500">{dateTime(event.observed_at)}</span></div><p className="mt-1 text-slate-600">{event.reason}</p>{event.price !== null ? <p className="mt-1 text-xs text-slate-500">{event.quantity ? `${event.quantity} shares · ` : ""}{decimalMoney(event.price)} · estimated fees {decimalMoney(event.fees_inr)}</p> : null}</div>)}</div> : <p className="mt-3 text-sm text-slate-500">No material Paper Auto decision has been recorded yet.</p>}
        </details>
    </section>;
}

function KiteConnectionCard({ connection, configured, worker, workerFresh, account, reconciliation, reconciliationRows }: {
    connection: KiteConnection | null;
    configured: boolean;
    worker: KiteWorkerHeartbeat | null;
    workerFresh: boolean;
    account: KiteAccountSnapshot | null;
    reconciliation: KiteReconciliationRun | null;
    reconciliationRows: KiteReconciliationRow[];
}) {
    const status = connection?.connection_status ?? "disconnected";
    const active = configured && status === "connected" && Boolean(connection?.has_active_session);
    const workerHealthy = Boolean(workerFresh && worker?.worker_status === "healthy" && worker.kite_session_healthy);
    const reconciliationHealthy = Boolean(workerFresh && worker?.reconciliation_healthy && reconciliation?.reconciliation_status === "matched");
    const accountUsable = Boolean(workerHealthy && account?.account_status === "healthy");
    const reconciliationAvailable = Boolean(workerFresh && worker?.kite_session_healthy && reconciliation);
    const reconciliationLabel = !workerFresh || !worker?.kite_session_healthy
        ? "Unavailable"
        : !reconciliation
            ? "Not run"
            : reconciliationHealthy
                ? "Matched"
                : reconciliation.reconciliation_status;
    const statusLabel = !configured
        ? "Configuration pending"
        : active && workerHealthy
            ? "Connected · verified by VPS"
            : active
                ? "Connected · waiting for VPS"
                : status === "expired"
                    ? "Session expired"
                    : status === "error"
                        ? "Connection error"
                        : "Not connected";
    const tone = active && workerHealthy
        ? "border-emerald-200 bg-emerald-50 text-emerald-800"
        : status === "error"
            ? "border-red-200 bg-red-50 text-red-800"
            : "border-amber-200 bg-amber-50 text-amber-900";

    return <section className="mb-6 rounded-xl border border-slate-200 bg-white p-5" aria-labelledby="kite-connection-title">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex gap-3">
                <div className="rounded-lg bg-blue-50 p-2 text-blue-700"><KeyRound className="h-5 w-5" /></div>
                <div><h2 id="kite-connection-title" className="text-lg font-semibold">Kite connection and VPS verification</h2><p className="mt-1 text-sm text-slate-500">The static-IP worker reads account state and compares live Swing Lab trades. Batch 2 cannot place, modify or cancel orders.</p></div>
            </div>
            <span role="status" className={`w-fit rounded-full border px-3 py-1 text-xs font-semibold uppercase ${tone}`}>{statusLabel}</span>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <SmallMetric label="Broker account" value={maskBrokerUserId(connection?.broker_user_id)} />
            <SmallMetric label="Session expires" value={dateTime(connection?.session_expires_at)} />
            <SmallMetric label="VPS worker" value={!worker ? "Not observed" : !workerFresh ? "Heartbeat stale" : worker.worker_status} />
            <SmallMetric label="Reconciliation" value={reconciliationLabel} />
            <SmallMetric label="Order execution" value="Blocked" />
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <div className="rounded-lg border border-slate-200 p-4">
                <div className="flex items-center gap-2"><Server className="h-4 w-4 text-blue-700" /><h3 className="text-sm font-semibold">Static-IP worker</h3></div>
                <dl className="mt-3 space-y-2 text-sm">
                    <OperationalRow label="Heartbeat" value={dateTime(worker?.heartbeat_at)} good={workerFresh} />
                    <OperationalRow label="Public IP" value={worker?.observed_public_ip ?? "Unavailable"} good={Boolean(workerFresh && worker?.observed_public_ip)} />
                    <OperationalRow label="Kite session" value={worker?.kite_session_healthy ? "Validated" : "Not validated"} good={Boolean(workerFresh && worker?.kite_session_healthy)} />
                    <OperationalRow label="Quote stream" value="Not started in Batch 2" />
                </dl>
            </div>
            <div className="rounded-lg border border-slate-200 p-4">
                <div className="flex items-center gap-2"><WalletCards className="h-4 w-4 text-blue-700" /><h3 className="text-sm font-semibold">Read-only account snapshot</h3></div>
                <dl className="mt-3 space-y-2 text-sm">
                    <OperationalRow label="Available cash" value={accountUsable ? optionalMoney(account?.available_cash) : "Unavailable"} good={accountUsable} />
                    <OperationalRow label="Holdings" value={accountUsable && account ? String(account.holdings_count) : "Unavailable"} />
                    <OperationalRow label="Open broker positions" value={accountUsable && account ? String(account.positions_count) : "Unavailable"} />
                    <OperationalRow label="Last successful read" value={dateTime(account?.observed_at)} good={accountUsable} />
                </dl>
            </div>
            <div className="rounded-lg border border-slate-200 p-4">
                <div className="flex items-center gap-2"><Activity className="h-4 w-4 text-blue-700" /><h3 className="text-sm font-semibold">Swing position reconciliation</h3></div>
                <dl className="mt-3 space-y-2 text-sm">
                    <OperationalRow label="Tracked live symbols" value={reconciliationAvailable && reconciliation ? String(reconciliation.tracker_positions) : "Unavailable"} />
                    <OperationalRow label="Matched" value={reconciliationAvailable && reconciliation ? String(reconciliation.matched_positions) : "Unavailable"} good={reconciliationAvailable ? reconciliationHealthy : false} />
                    <OperationalRow label="Mismatched" value={reconciliationAvailable && reconciliation ? String(reconciliation.mismatch_positions) : "Unavailable"} good={reconciliationAvailable ? reconciliation?.mismatch_positions === 0 : false} />
                    <OperationalRow label="Other broker holdings" value={reconciliationAvailable && reconciliation ? `${reconciliation.broker_only_positions} informational` : "Unavailable"} />
                </dl>
            </div>
        </div>

        {!configured ? <div role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p className="font-semibold">Vercel configuration required</p><p className="mt-1">Add the documented server-side Kite variables after deploying this code. No credentials belong in browser-exposed settings.</p></div> : null}
        {connection?.error_message ? <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">{connection.error_message}</div> : null}
        {active && !workerFresh ? <div role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p className="font-semibold">VPS worker is not current</p><p className="mt-1">Authentication succeeded, but no fresh worker heartbeat was received within ten minutes. Broker data and reconciliation must be treated as unavailable.</p></div> : null}
        {reconciliationAvailable && reconciliation?.reconciliation_status === "mismatch" ? <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"><p className="font-semibold">Broker and Swing Lab differ</p><p className="mt-1">Review these quantities. New automatic entries remain fail-closed.</p><ul className="mt-2 space-y-1 text-xs">{reconciliationRows.filter((row) => row.reconciliation_status === "mismatch").map((row) => <li key={row.symbol}>{row.symbol}: Tracker {row.tracker_quantity ?? "unavailable"} · Kite {row.broker_quantity ?? "unavailable"}</li>)}</ul></div> : null}

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            {configured ? <a href="/api/kite/login" className="inline-flex items-center justify-center rounded-lg bg-slate-950 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2">{active ? "Reconnect Kite for today" : "Connect Kite for today"}</a> : <button type="button" disabled className="rounded-lg bg-slate-200 px-4 py-2.5 text-sm font-medium text-slate-500">Connect Kite for today</button>}
            {connection && status !== "disconnected" ? <form action={disconnectKiteAccount}><ConfirmSubmitButton confirmation="Remove the locally stored Kite session? Swing automation will remain advisory and disarmed." pendingText="Removing session...">Remove stored session</ConfirmSubmitButton></form> : null}
            <p className="flex items-center gap-2 text-xs text-slate-500"><ShieldCheck className="h-4 w-4 text-emerald-600" />Encrypted token · daily expiry · read-only allow-list · no live orders</p>
        </div>
    </section>;
}

function OperationalRow({ label, value, good }: { label: string; value: string; good?: boolean }) {
    const tone = good === undefined ? "text-slate-700" : good ? "text-emerald-700" : "text-amber-700";
    return <div className="flex items-start justify-between gap-3"><dt className="text-slate-500">{label}</dt><dd className={`text-right font-medium capitalize ${tone}`}>{value}</dd></div>;
}

function CandidateCard({ candidate, settings, today, entryAllowed, entryBlockedReason, carriedForward }: { candidate: Candidate; settings: Settings; today: string; entryAllowed: boolean; entryBlockedReason: string | null; carriedForward: boolean }) {
    const testOnly = candidate.setup_type.startsWith("TEST_");
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
        <div className="flex items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-bold">{candidate.symbol}</h3><span className={`rounded-full px-2.5 py-1 text-xs font-semibold uppercase ${triggered ? "bg-emerald-50 text-emerald-700" : "bg-blue-50 text-blue-700"}`}>{candidate.status}</span>{carriedForward ? <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold uppercase text-amber-800">Carried forward</span> : null}</div><p className="mt-1 text-sm text-slate-600">{candidate.company_name}</p><p className="mt-1 text-xs text-slate-400">{candidate.sector || "Sector unavailable"} · expires {date(candidate.expires_on)}</p></div><div className="text-right"><p className="text-xs uppercase tracking-wide text-slate-400">Setup score</p><p className="mt-1 text-2xl font-bold text-blue-700">{num(candidate.setup_score).toFixed(0)}</p></div></div>
        {testOnly ? <div role="alert" className="mt-4 rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm text-violet-800"><strong>Test candidate:</strong> generated only to exercise the interface. It is forced to Paper and must not be treated as a live signal.</div> : null}
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4"><SmallMetric label="Entry above" value={decimalMoney(candidate.entry_trigger)} /><SmallMetric label="Maximum entry" value={decimalMoney(candidate.maximum_entry)} /><SmallMetric label="Initial stop" value={decimalMoney(candidate.initial_stop)} /><SmallMetric label="Suggested" value={`${suggestedQuantity} shares`} /></div>
        <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600"><p><strong>Planned risk:</strong> {money(risk)} · <strong>Risk/share:</strong> {decimalMoney(candidate.risk_per_share)}. Exits follow protective-stop, trailing-stop and time-review rules; there is no fixed profit target.</p>{stringList(candidate.reasons).length ? <ul className="mt-2 space-y-1 text-xs">{stringList(candidate.reasons).map((reason) => <li key={reason}>• {reason}</li>)}</ul> : null}</div>
        {entryAllowed ? <details className="mt-4 rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer text-sm font-semibold">Confirm that I entered this trade</summary><form action={confirmSwingEntry} className="mt-4 grid gap-3 sm:grid-cols-2"><input type="hidden" name="candidate_id" value={candidate.id} /><NumberField name="entry_price" label={testOnly ? "Paper fill price" : "Actual fill price"} value={num(candidate.entry_trigger)} min={0.01} step={0.01} /><NumberField name="quantity" label="Actual quantity" value={suggestedQuantity} min={1} step={1} /><DateField name="entry_date" label="Entry date" value={today} />{testOnly ? <><input type="hidden" name="trade_mode" value="paper" /><div className="rounded-lg bg-violet-50 p-3 text-sm font-medium text-violet-800">Trade mode: Paper only</div></> : <label className="block text-sm font-medium text-slate-700">Trade mode<select name="trade_mode" defaultValue={settings.paper_mode ? "paper" : "live"} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2"><option value="paper">Paper</option><option value="live">Live</option></select></label>}<label className="block text-sm font-medium text-slate-700 sm:col-span-2">Note<input name="notes" placeholder="Optional entry note" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" /></label><div className="sm:col-span-2"><FormSubmitButton pendingText="Confirming entry...">{testOnly ? "Start test paper tracking" : "Start tracking actual entry"}</FormSubmitButton></div></form></details> : <div role="status" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p className="font-semibold">Entry confirmation unavailable</p><p className="mt-1">{entryBlockedReason ?? "Wait for a valid fresh scan before entering this candidate."}</p></div>}
        <form action={skipSwingCandidate} className="mt-3 flex flex-col gap-2 sm:flex-row"><input type="hidden" name="candidate_id" value={candidate.id} /><input name="reason" placeholder="Optional skip reason" className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm" /><ConfirmSubmitButton confirmation={`Skip ${candidate.symbol}?`} pendingText="Skipping...">Skip candidate</ConfirmSubmitButton></form>
    </article>;
}

function OpenTradeCard({ trade, today }: { trade: Trade; today: string }) {
    const corporateActionReview = trade.corporate_action_review_required;
    const current = trade.current_price === null ? num(trade.entry_price) : num(trade.current_price);
    const pnl = trade.unrealized_pnl_inr === null ? (current - num(trade.entry_price)) * trade.quantity : num(trade.unrealized_pnl_inr);
    const r = trade.unrealized_r_multiple === null ? pnl / Math.max(num(trade.planned_risk_inr), 0.01) : num(trade.unrealized_r_multiple);
    return <article className={`rounded-xl border bg-white p-5 ${corporateActionReview ? "border-amber-300 ring-1 ring-amber-100" : trade.status === "exit_pending" ? "border-red-300 ring-1 ring-red-100" : "border-slate-200"}`}>
        <div className="flex items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-bold">{trade.symbol}</h3><span className={`rounded-full px-2.5 py-1 text-xs font-semibold uppercase ${trade.status === "exit_pending" ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>{trade.status.replace("_", " ")}</span><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium uppercase text-slate-600">{trade.trade_mode}</span>{trade.execution_source === "paper_auto" ? <span className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-medium uppercase text-violet-700">Paper Auto</span> : null}</div><p className="mt-1 text-sm text-slate-600">{trade.quantity} shares · entered {date(trade.entry_date)}</p></div><div className="text-right">{corporateActionReview ? <><p className="text-lg font-bold text-amber-700">Monitoring paused</p><p className="text-xs text-slate-500">P&L basis requires reconciliation</p></> : <><p className={`text-xl font-bold ${pnl > 0 ? "text-emerald-700" : pnl < 0 ? "text-red-700" : "text-slate-950"}`}>{money(pnl)}</p><p className="text-xs font-medium text-slate-500">{signed(r, "R")}</p></>}</div></div>
        {corporateActionReview ? <div role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p className="font-semibold">Corporate action detected</p><p className="mt-1">{trade.corporate_action_reason ?? "Confirm the broker-adjusted quantity, entry and stop values before monitoring resumes."}</p></div> : null}
        {trade.status === "exit_pending" ? <div className="mt-4 flex gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><div><p className="font-semibold">Exit action pending</p><p>{trade.exit_signal_reason ?? "A strategy exit condition was reached."}</p></div></div> : null}
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4"><SmallMetric label="Entry" value={decimalMoney(trade.entry_price)} /><SmallMetric label="Current" value={decimalMoney(current)} /><SmallMetric label="Protective stop" value={decimalMoney(trade.current_stop)} /><SmallMetric label="Highest close" value={decimalMoney(trade.highest_close ?? trade.entry_price)} /></div>
        <p className="mt-3 text-xs text-slate-400">Price as of {trade.execution_source === "paper_auto" ? dateTime(trade.last_quote_at) : date(trade.current_price_as_of)}. A gap through the stop may fill below the displayed stop.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {corporateActionReview ? <details className="rounded-lg border border-amber-200 p-3" open><summary className="cursor-pointer text-sm font-semibold">Reconcile broker-adjusted values</summary><form action={reconcileSwingCorporateAction} className="mt-3 space-y-3"><input type="hidden" name="trade_id" value={trade.id} /><p className="text-xs text-amber-800">Enter the values shown by your broker after the split or bonus. Zero placeholders must be replaced.</p><NumberField name="adjusted_entry_price" label="Adjusted average entry" value={0} min={0.01} step={0.01} /><NumberField name="adjusted_quantity" label="Adjusted quantity" value={0} min={1} step={1} /><NumberField name="adjusted_initial_stop" label="Adjusted initial stop" value={0} min={0.01} step={0.01} /><NumberField name="adjusted_current_stop" label="Adjusted current stop" value={0} min={0.01} step={0.01} /><input name="notes" required placeholder="Broker action and adjustment ratio" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" /><ConfirmSubmitButton confirmation={`Resume ${trade.symbol} monitoring with these broker-adjusted values?`} pendingText="Reconciling...">Save reconciliation</ConfirmSubmitButton></form></details> : <details className="rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer text-sm font-semibold">Raise stop manually</summary><form action={updateSwingStop} className="mt-3 space-y-3"><input type="hidden" name="trade_id" value={trade.id} /><NumberField name="new_stop" label="New stop" value={num(trade.current_stop)} min={num(trade.current_stop)} step={0.01} /><input name="reason" placeholder="Reason" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" /><FormSubmitButton pendingText="Updating stop...">Update stop</FormSubmitButton></form></details>}
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

function ExecutionToneCell({ value, text }: { value: number | null; text: string }) {
    const tone = value === null || value === 0 ? "text-slate-500" : value > 0 ? "text-red-700" : "text-emerald-700";
    return <td className={`px-5 py-4 text-right font-medium ${tone}`}>{text}</td>;
}
