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
    cancelSwingGttAssistedEntry,
    confirmSwingEntry,
    confirmSwingExit,
    clearSwingRiskControl,
    configureSwingLiveMode,
    configureSwingGttAssisted,
    configureSwingPaperAuto,
    createSwingGttAssistedEntry,
    decideSwingAssistedIntent,
    disconnectKiteAccount,
    resetKiteBrokerIdentity,
    reconcileSwingCorporateAction,
    saveSwingSettings,
    saveSwingLiveReadiness,
    setSwingEmergencyStop,
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
    execution_source: "manual" | "paper_auto" | "gtt_assisted" | "assisted_live" | "live_auto";
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
    execution_mode: "observe" | "paper_auto" | "gtt_assisted" | "assisted_live" | "live_auto";
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
    assisted_live_unlocked: boolean;
    live_auto_unlocked: boolean;
    broker_execution_enabled: boolean;
    ddpi_confirmed_at: string | null;
    market_data_plan: "personal" | "connect";
    gtt_assisted_enabled: boolean;
    live_max_open_positions: number;
    live_max_new_entries_per_day: number;
    live_max_deployed_inr: number | string;
    live_daily_loss_limit_inr: number | string;
    live_risk_per_trade_percentage: number | string;
    live_amber_risk_multiplier: number | string;
};
type LiveOrderIntent = {
    id: string;
    intent_purpose: "entry" | "exit" | "protective_stop" | "replace_stop" | "cancel";
    automation_mode: "assisted_live" | "live_auto";
    status: string;
    approval_status: "not_required" | "pending" | "approved" | "rejected" | "expired";
    approval_expires_at: string | null;
    symbol: string;
    transaction_type: "BUY" | "SELL";
    quantity: number;
    limit_price: number | string | null;
    trigger_price: number | string | null;
    requested_at: string;
    failure_reason: string | null;
};
type GttAssistedEntry = {
    id: string;
    intent_id: string;
    candidate_id: string | null;
    symbol: string;
    broker_trigger_id: string | null;
    broker_order_id: string | null;
    status: "pending_submission" | "active" | "triggered" | "order_open" | "cancel_requested" | "filled" | "cancelled" | "expired" | "rejected" | "failed";
    reference_last_price: number | string;
    entry_trigger: number | string;
    maximum_entry: number | string;
    initial_stop: number | string;
    quantity: number;
    target_r_multiple: number | string;
    armed_nse_session: string;
    cancel_after: string;
    submitted_at: string | null;
    triggered_at: string | null;
    completed_at: string | null;
    last_verified_at: string | null;
    failure_reason: string | null;
};
type LiveBrokerOrder = {
    id: string;
    intent_id: string;
    broker_order_id: string;
    status: string;
    quantity: number;
    filled_quantity: number;
    average_price: number | string | null;
    status_message: string | null;
    updated_at: string;
};
type LiveProtection = {
    id: string;
    trade_id: string;
    broker_trigger_id: string | null;
    status: string;
    protected_quantity: number;
    trigger_price: number | string;
    limit_price: number | string | null;
    last_verified_at: string | null;
    failure_reason: string | null;
};
type LiveRiskLock = {
    id: string;
    control_type: string;
    reason: string;
    activated_at: string;
};
type RolloutReadiness = {
    phase7_ready: boolean;
    phase8_ready: boolean;
    phase9_ready: boolean;
    live_modes_locked: boolean;
    counts: {
        paper_quote_sessions: number;
        paper_entry_events: number;
        paper_exit_events: number;
        assisted_live_closed_trades: number;
        active_risk_locks: number;
    };
    limits: {
        max_open_positions: number;
        max_new_entries_per_day: number;
        max_deployed_inr: number | string;
        daily_loss_limit_inr: number | string;
        risk_per_trade_percentage: number | string;
        amber_risk_multiplier: number | string;
    };
    checks: Array<{ key: string; passed: boolean; reason: string }>;
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
type TechnicalSetup = {
    id: string;
    scan_id: string;
    signal_key: string;
    symbol: string;
    company_name: string;
    sector: string | null;
    setup_score: number | string;
    setup_as_of: string;
    expires_on: string;
    market_regime: string;
    close_price: number | string;
    entry_trigger: number | string;
    maximum_entry: number | string;
    initial_stop: number | string;
    suggested_quantity: number;
    actionability_status: string;
    execution_block_reasons: unknown;
};
type PerformanceScorecard = {
    source: string;
    closed_trades: number;
    open_trades: number;
    net_pnl_inr: number | string;
    expectancy_r: number | string | null;
    win_rate_percentage: number | string | null;
};
type CandidateLifecycleScorecard = {
    window_days: number;
    published: number;
    triggered: number;
    entered: number;
    expired: number;
    invalidated: number;
    trigger_rate_percentage: number | string | null;
    entry_rate_percentage: number | string | null;
    median_hours_to_trigger: number | string | null;
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

    const [settingsResult, scanResult, monitorResult, candidatesResult, tradesResult, tradeEventsResult, deliveriesResult, kiteConnectionResult, kiteWorkerResult, kiteAccountResult, kiteReconciliationResult, kiteReconciliationRowsResult, automationResult, gttWorkerResult, gttEntriesResult, paperWorkerResult, paperEventsResult, readinessResult, liveWorkerResult, liveIntentsResult, liveOrdersResult, liveProtectionsResult, liveRiskLocksResult, watchlistResult, scorecardsResult, lifecycleResult] = await Promise.all([
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
        supabase.from("swing_automation_controls").select("automation_mode, new_entries_enabled, armed_nse_session, emergency_stop_active, paper_slippage_bps, paper_max_new_entries_per_day, assisted_live_unlocked, live_auto_unlocked, broker_execution_enabled, ddpi_confirmed_at, market_data_plan, gtt_assisted_enabled, live_max_open_positions, live_max_new_entries_per_day, live_max_deployed_inr, live_daily_loss_limit_inr, live_risk_per_trade_percentage, live_amber_risk_multiplier").eq("user_id", user.id).maybeSingle(),
        supabase.from("swing_worker_heartbeats").select("worker_id, worker_version, observed_public_ip, worker_status, execution_mode, kite_session_healthy, quote_stream_healthy, reconciliation_healthy, heartbeat_at, details").eq("user_id", user.id).eq("execution_mode", "gtt_assisted").order("heartbeat_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("swing_gtt_assisted_entries").select("id, intent_id, candidate_id, symbol, broker_trigger_id, broker_order_id, status, reference_last_price, entry_trigger, maximum_entry, initial_stop, quantity, target_r_multiple, armed_nse_session, cancel_after, submitted_at, triggered_at, completed_at, last_verified_at, failure_reason").eq("user_id", user.id).order("created_at", { ascending: false }).limit(30),
        supabase.from("swing_worker_heartbeats").select("worker_id, worker_version, observed_public_ip, worker_status, execution_mode, kite_session_healthy, quote_stream_healthy, reconciliation_healthy, heartbeat_at, details").eq("user_id", user.id).eq("execution_mode", "paper_auto").order("heartbeat_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("swing_paper_events").select("id, event_type, symbol, quantity, price, fees_inr, reason, observed_at").eq("user_id", user.id).order("observed_at", { ascending: false }).limit(20),
        supabase.rpc("get_swing_rollout_readiness"),
        supabase.from("swing_worker_heartbeats").select("worker_id, worker_version, observed_public_ip, worker_status, execution_mode, kite_session_healthy, quote_stream_healthy, reconciliation_healthy, heartbeat_at, details").eq("user_id", user.id).in("execution_mode", ["assisted_live", "live_auto"]).order("heartbeat_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("swing_order_intents").select("id, intent_purpose, automation_mode, status, approval_status, approval_expires_at, symbol, transaction_type, quantity, limit_price, trigger_price, requested_at, failure_reason").eq("user_id", user.id).in("automation_mode", ["assisted_live", "live_auto"]).order("requested_at", { ascending: false }).limit(30),
        supabase.from("swing_broker_orders").select("id, intent_id, broker_order_id, status, quantity, filled_quantity, average_price, status_message, updated_at").eq("user_id", user.id).order("updated_at", { ascending: false }).limit(30),
        supabase.from("swing_protective_orders").select("id, trade_id, broker_trigger_id, status, protected_quantity, trigger_price, limit_price, last_verified_at, failure_reason").eq("user_id", user.id).order("updated_at", { ascending: false }).limit(30),
        supabase.from("swing_risk_control_activations").select("id, control_type, reason, activated_at").eq("user_id", user.id).eq("status", "active").order("activated_at", { ascending: false }).limit(20),
        supabase.from("swing_setup_watchlist").select("id, scan_id, signal_key, symbol, company_name, sector, setup_score, setup_as_of, expires_on, market_regime, close_price, entry_trigger, maximum_entry, initial_stop, suggested_quantity, actionability_status, execution_block_reasons").eq("user_id", user.id).order("setup_score", { ascending: false }).limit(20),
        supabase.rpc("get_swing_performance_scorecards"),
        supabase.rpc("get_swing_candidate_lifecycle_scorecard"),
    ]);
    const params = await searchParams;
    const queryError = settingsResult.error || scanResult.error || monitorResult.error || candidatesResult.error || tradesResult.error || tradeEventsResult.error || deliveriesResult.error || kiteConnectionResult.error || kiteWorkerResult.error || kiteAccountResult.error || kiteReconciliationResult.error || kiteReconciliationRowsResult.error || automationResult.error || gttWorkerResult.error || gttEntriesResult.error || paperWorkerResult.error || paperEventsResult.error || readinessResult.error || liveWorkerResult.error || liveIntentsResult.error || liveOrdersResult.error || liveProtectionsResult.error || liveRiskLocksResult.error || watchlistResult.error || scorecardsResult.error || lifecycleResult.error;
    if (queryError) {
        return <main className="mx-auto max-w-5xl px-4 py-8"><div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-5 text-red-800"><h1 className="font-semibold">Swing Lab migration required</h1><p className="mt-2 text-sm">{queryError.message}</p><p className="mt-2 text-xs">Apply all pending Supabase migrations through <code>202608110002_swing_observability_and_delivery.sql</code>, then reload this page.</p></div></main>;
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
        assisted_live_unlocked: false, broker_execution_enabled: false,
        live_auto_unlocked: false,
        ddpi_confirmed_at: null,
        market_data_plan: "personal", gtt_assisted_enabled: false, live_max_open_positions: 1,
        live_max_new_entries_per_day: 1, live_max_deployed_inr: 5000,
        live_daily_loss_limit_inr: 100, live_risk_per_trade_percentage: 0.5,
        live_amber_risk_multiplier: 0.5,
    }) as AutomationControls;
    const gttWorker = (gttWorkerResult.data ?? null) as KiteWorkerHeartbeat | null;
    const gttEntries = (gttEntriesResult.data ?? []) as GttAssistedEntry[];
    const paperWorker = (paperWorkerResult.data ?? null) as KiteWorkerHeartbeat | null;
    const paperEvents = (paperEventsResult.data ?? []) as PaperEvent[];
    const readiness = readinessResult.data as RolloutReadiness;
    const liveWorker = (liveWorkerResult.data ?? null) as KiteWorkerHeartbeat | null;
    const liveIntents = (liveIntentsResult.data ?? []) as LiveOrderIntent[];
    const liveOrders = (liveOrdersResult.data ?? []) as LiveBrokerOrder[];
    const liveProtections = (liveProtectionsResult.data ?? []) as LiveProtection[];
    const liveRiskLocks = (liveRiskLocksResult.data ?? []) as LiveRiskLock[];
    const technicalSetups = ((watchlistResult.data ?? []) as TechnicalSetup[])
        .filter((setup) => setup.scan_id === latestScan?.id);
    const scorecards = (scorecardsResult.data ?? []) as PerformanceScorecard[];
    const lifecycle = (lifecycleResult.data ?? {
        window_days: 180, published: 0, triggered: 0, entered: 0, expired: 0, invalidated: 0,
        trigger_rate_percentage: null, entry_rate_percentage: null, median_hours_to_trigger: null,
    }) as CandidateLifecycleScorecard;
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
    const liveWorkerFresh = Boolean(
        liveWorker && now.getTime() - new Date(liveWorker.heartbeat_at).getTime() <= 2 * 60_000,
    );
    const gttWorkerFresh = Boolean(
        gttWorker && now.getTime() - new Date(gttWorker.heartbeat_at).getTime() <= 2 * 60_000,
    );
    const currentIndiaDate = getIndiaDate(now);
    const paperAutoArmed = automation.automation_mode === "paper_auto"
        && automation.new_entries_enabled
        && automation.armed_nse_session === currentIndiaDate
        && !automation.emergency_stop_active;
    const liveModeArmed = ["assisted_live", "live_auto"].includes(automation.automation_mode)
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
    const kiteConnected = Boolean(kiteConfiguration.configured && kiteConnection?.connection_status === "connected" && kiteConnection.has_active_session);
    const openGttCandidateIds = new Set(gttEntries
        .filter((entry) => ["pending_submission", "active", "triggered", "order_open", "cancel_requested"].includes(entry.status))
        .map((entry) => entry.candidate_id)
        .filter((value): value is string => Boolean(value)));
    const triggeredCandidates = activeCandidates.filter((candidate) => candidate.status === "triggered");
    const nextAction = automation.emergency_stop_active
        ? "Review and clear the emergency stop only after its cause is resolved."
        : liveRiskLocks.length
            ? "Review the active execution risk lock before enabling any new entry."
            : !kiteConnected
                ? "Connect Kite for today if you want broker reconciliation or GTT Assisted. Advisory research remains available."
                : triggeredCandidates.length
                    ? `Review ${triggeredCandidates.length} monitor-confirmed trigger${triggeredCandidates.length === 1 ? "" : "s"}. Confirm only a real fill from Kite.`
                    : activeCandidates.length
                        ? `Watch ${activeCandidates.length} ready setup${activeCandidates.length === 1 ? "" : "s"}; no manual entry is available until the monitor confirms a trigger.`
                        : "No entry action is required. Wait for the next completed-session scan."

    return <main><div className="mx-auto max-w-7xl px-4 py-8">
        <PageHeader title="Swing Lab" description="End-of-day Indian equity candidates, Personal Free GTT assistance, Paper Auto validation, and staged live execution." />
        <StatusBanner success={params.success} error={params.error} />
        <AnalyzerDeliveryAlerts deliveries={deliveryRows} returnTo="/swing-lab" resolveAction={resolveAnalyzerDelivery} />
        {latestScan ? <AnalyzerContractStatus version={latestScan.contract_version} publisher="Swing scan" /> : null}
        {latestMonitor ? <AnalyzerContractStatus version={latestMonitor.contract_version} publisher="Swing monitor" /> : null}
        <section className="mb-6 rounded-xl border border-blue-200 bg-gradient-to-br from-blue-50 to-white p-5" aria-labelledby="swing-next-action">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div><p className="text-xs font-semibold uppercase tracking-wide text-blue-700">What should I do now?</p><h2 id="swing-next-action" className="mt-1 text-lg font-semibold text-slate-950">{nextAction}</h2><p className="mt-2 text-sm text-slate-600">Current mode: <strong>{automation.gtt_assisted_enabled ? "GTT Assisted" : paperAutoArmed ? "Paper Auto" : liveModeArmed ? automation.automation_mode.replaceAll("_", " ") : "Advisory"}</strong>. A ready setup is a watchlist item; only a monitor-confirmed trigger or an explicitly approved broker GTT can become a trade.</p></div>
                <div className="grid min-w-fit grid-cols-2 gap-2 text-center text-sm"><QuickState label="Ready setups" value={String(activeCandidates.length)} /><QuickState label="Triggered now" value={String(triggeredCandidates.length)} tone={triggeredCandidates.length ? "good" : undefined} /></div>
            </div>
        </section>
        <nav aria-label="Swing Lab sections" className="mb-6 flex gap-2 overflow-x-auto rounded-xl border border-slate-200 bg-white p-2 text-sm font-medium">
            {[['overview','Overview'],['setups','Setups'],['positions','Positions'],['journal','Journal'],['automation','Automation'],['settings','Settings']].map(([href,label]) => <a key={href} href={`#${href}`} className="whitespace-nowrap rounded-lg px-3 py-2 text-slate-600 hover:bg-slate-100 hover:text-slate-950">{label}</a>)}
        </nav>
        {scanHeartbeatMissed ? <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900"><p className="font-semibold">End-of-day scan heartbeat is missing</p><p className="mt-1">No scan was published for the latest expected workflow date, {date(expectedScanDate)}. Check the GitHub Action and Tracker publication logs.</p></div> : latestScan?.status === "failed" ? <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">The latest end-of-day scan failed. Do not treat older candidates as newly validated.</div> : null}
        {monitorHeartbeatMissed ? <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900"><p className="font-semibold">Morning monitor heartbeat is missing</p><p className="mt-1">No monitor was published for the latest expected workflow date, {date(expectedMonitorDate)}. Verify open positions directly with your broker until the job recovers.</p></div> : latestMonitor?.status === "failed" ? <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">The latest morning monitor failed. No requested record could be evaluated from fresh data; verify candidates and stops with your broker.</div> : latestMonitor?.status === "partial" ? <div role="alert" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">The latest morning monitor was partial. Only the explicitly evaluated records below received a fresh check.</div> : null}

        <section id="overview" className="scroll-mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <Summary label="Trading capital" value={money(settings.trading_capital_inr)} helper={settings.paper_mode ? "Paper mode" : "Live mode"} />
            <Summary label="Open positions" value={`${openTrades.length}/${settings.max_open_positions}`} helper={`${money(metrics.openCapitalInr)} deployed`} />
            <Summary label="Open risk" value={money(metrics.openRiskInr)} helper="Entry minus current stop" tone={metrics.openRiskInr > 0 ? "warn" : undefined} />
            <Summary label="Realized P&L" value={money(metrics.totalRealizedPnlInr)} helper={`${metrics.closedTrades} closed trades`} tone={metrics.totalRealizedPnlInr > 0 ? "good" : metrics.totalRealizedPnlInr < 0 ? "bad" : undefined} />
            <Summary label="Average expectancy" value={metrics.averageRMultiple === null ? "Not enough data" : signed(metrics.averageRMultiple, "R")} helper={metrics.winRatePercentage === null ? "No closed trades" : `${metrics.winRatePercentage.toFixed(0)}% win rate`} tone={metrics.averageRMultiple === null ? undefined : metrics.averageRMultiple > 0 ? "good" : "bad"} />
        </section>

        <section className="mt-6 scroll-mt-6 rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div><h2 className="text-lg font-semibold">Latest end-of-day scan</h2><p className="mt-1 text-sm text-slate-500">Candidates are research priorities. Advisory waits for your fill; GTT Assisted requires a manually confirmed below-trigger Kite LTP; Paper Auto uses official Connect quotes.</p></div>
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

        <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5" aria-labelledby="technical-watchlist-title">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Research layer</p><h2 id="technical-watchlist-title" className="mt-1 text-lg font-semibold">Technical watchlist</h2><p className="mt-1 text-sm text-slate-500">These stocks passed the chart-quality gates. Portfolio limits may still prevent an actionable entry.</p></div><span className="text-sm text-slate-500">{technicalSetups.length} retained from this scan</span></div>
            {technicalSetups.length ? <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{technicalSetups.map((setup) => <div key={setup.id} className="rounded-xl border border-slate-200 p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{setup.symbol}</p><p className="text-xs text-slate-500">{setup.company_name} · {setup.sector ?? "Unclassified"}</p></div><span className={`rounded-full px-2 py-1 text-[11px] font-semibold uppercase ${setup.actionability_status === "actionable" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{setup.actionability_status.replaceAll("_", " ")}</span></div><div className="mt-3 grid grid-cols-3 gap-2 text-sm"><SmallMetric label="Score" value={num(setup.setup_score).toFixed(0)} /><SmallMetric label="Trigger" value={decimalMoney(setup.entry_trigger)} /><SmallMetric label="Qty" value={String(setup.suggested_quantity)} /></div>{stringList(setup.execution_block_reasons).length ? <p className="mt-3 text-xs text-amber-800">{stringList(setup.execution_block_reasons).join(" ")}</p> : <p className="mt-3 text-xs text-emerald-700">Eligible for the actionable-candidate layer.</p>}</div>)}</div> : <p className="mt-4 rounded-lg bg-slate-50 p-4 text-sm text-slate-500">No technical setup was retained from the latest completed scan.</p>}
        </section>

        <section id="setups" className="mt-6 scroll-mt-6">
            <div className="flex items-end justify-between gap-4"><div><h2 className="text-xl font-semibold">{candidateEntryAllowed ? "Actionable candidates" : "Candidates for review"}</h2><p className="mt-1 text-sm text-slate-500">{candidateEntryAllowed ? "Review the conditional entry, maximum acceptable price, stop and expiry before acting." : "Older candidates remain visible for context, but entry confirmation is disabled until scan validity is restored."}</p></div><span className="text-sm text-slate-500">{activeCandidates.length} active</span></div>
            {candidateEntryBlockedReason ? <div role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p className="font-semibold">New entries are temporarily disabled</p><p className="mt-1">{candidateEntryBlockedReason}</p></div> : null}
            {paperAutoArmed ? <div role="status" className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900"><p className="font-semibold">Paper Auto is watching eligible candidates</p><p className="mt-1">Manual entry confirmation is disabled while armed to prevent duplicate tracking. No Kite order will be placed.</p></div> : null}
            {liveModeArmed ? <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900"><p className="font-semibold">{automation.automation_mode === "live_auto" ? "Live Auto" : "Assisted Live"} is armed</p><p className="mt-1">Manual entry confirmation is disabled to prevent duplicate positions. Broker submission still requires every database and VPS safety gate.</p></div> : null}
            {activeCandidates.length ? <div className="mt-4 grid gap-4 xl:grid-cols-2">{activeCandidates.map((candidate) => <CandidateCard key={candidate.id} candidate={candidate} settings={settings} today={currentIndiaDate} entryAllowed={candidateEntryAllowed && !paperAutoArmed && !liveModeArmed} entryBlockedReason={paperAutoArmed ? "Paper Auto is armed and watching this candidate for a fresh live trigger crossing." : liveModeArmed ? "A live execution mode is armed and owns candidate entry processing." : candidateEntryBlockedReason} carriedForward={Boolean(latestScan && candidate.scan_id !== latestScan.id)} gttAssistedAvailable={automation.market_data_plan === "personal" && automation.gtt_assisted_enabled && kiteConnected && gttWorkerFresh && gttWorker?.worker_status === "healthy" && gttWorker.kite_session_healthy && !automation.emergency_stop_active} hasOpenGtt={openGttCandidateIds.has(candidate.id)} />)}</div> : <div className="mt-4 rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">No active candidates. “No trade” is expected when the hard gates or setup quality are not satisfied.</div>}
        </section>

        <section id="positions" className="mt-8 scroll-mt-6">
            <div><h2 className="text-xl font-semibold">Open positions</h2><p className="mt-1 text-sm text-slate-500">Manual records use your confirmed broker fills. Paper Auto records simulated live-quote fills and never sends an order.</p></div>
            {openTrades.length ? <div className="mt-4 grid gap-4 xl:grid-cols-2">{openTrades.map((trade) => <OpenTradeCard key={trade.id} trade={trade} today={currentIndiaDate} />)}</div> : <div className="mt-4 rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">No confirmed paper or live positions.</div>}
        </section>

        <section id="journal" className="mt-8 scroll-mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-5 py-4"><h2 className="text-lg font-semibold">Closed-trade journal</h2><p className="mt-1 text-sm text-slate-500">Use R-multiples and expectancy to judge the system after a meaningful sample, not one outcome.</p></div>
            {closedTrades.length ? <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><caption className="sr-only">Closed swing trades and realized performance</caption><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-5 py-3">Stock</th><th className="px-5 py-3">Mode</th><th className="px-5 py-3">Entry / exit</th><th className="px-5 py-3 text-right">Quantity</th><th className="px-5 py-3 text-right">Realized P&L</th><th className="px-5 py-3 text-right">Result</th><th className="px-5 py-3">Exit date</th></tr></thead><tbody className="divide-y divide-slate-100">{closedTrades.map((trade) => <tr key={trade.id}><td className="px-5 py-4"><p className="font-semibold">{trade.symbol}</p><p className="text-xs text-slate-500">{trade.company_name}</p></td><td className="px-5 py-4 uppercase"><p>{trade.trade_mode}</p><p className="text-xs text-slate-400">{trade.execution_source.replaceAll("_", " ")}</p></td><td className="px-5 py-4">{decimalMoney(trade.entry_price)} → {decimalMoney(trade.exit_price)}</td><td className="px-5 py-4 text-right">{trade.quantity}</td><ToneCell value={num(trade.realized_pnl_inr)} text={money(trade.realized_pnl_inr)} /><ToneCell value={num(trade.realized_r_multiple)} text={signed(trade.realized_r_multiple, "R")} /><td className="px-5 py-4">{date(trade.exit_date)}</td></tr>)}</tbody></table></div> : <p className="p-5 text-sm text-slate-500">Closed trades will appear here.</p>}
            {metrics.closedTrades > 0 ? <div className="grid gap-3 border-t border-slate-100 p-5 sm:grid-cols-2 lg:grid-cols-4"><SmallMetric label="Profit factor" value={metrics.profitFactor === null ? "N/A" : Number.isFinite(metrics.profitFactor) ? metrics.profitFactor.toFixed(2) : "∞"} /><SmallMetric label="Maximum drawdown" value={money(metrics.maximumDrawdownInr)} /><SmallMetric label="Winning trades" value={String(metrics.winningTrades)} /><SmallMetric label="Losing trades" value={String(metrics.losingTrades)} /></div> : null}
            <div className="border-t border-slate-100 p-5"><h3 className="text-sm font-semibold">Candidate conversion · last {lifecycle.window_days} days</h3><p className="mt-1 text-xs text-slate-500">This measures how published actionable candidates progressed. Technical watchlist rows are excluded until they become published candidates.</p><div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><SmallMetric label="Published" value={String(lifecycle.published)} /><SmallMetric label="Triggered" value={`${lifecycle.triggered}${lifecycle.trigger_rate_percentage === null ? "" : ` · ${num(lifecycle.trigger_rate_percentage).toFixed(0)}%`}`} /><SmallMetric label="Entered" value={`${lifecycle.entered}${lifecycle.entry_rate_percentage === null ? "" : ` · ${num(lifecycle.entry_rate_percentage).toFixed(0)}% of triggers`}`} /><SmallMetric label="Expired / invalid" value={`${lifecycle.expired} / ${lifecycle.invalidated}`} /><SmallMetric label="Median trigger time" value={lifecycle.median_hours_to_trigger === null ? "Not enough data" : `${num(lifecycle.median_hours_to_trigger).toFixed(1)} hours`} /></div></div>
            {scorecards.length ? <div className="border-t border-slate-100 p-5"><h3 className="text-sm font-semibold">Performance by execution mode</h3><p className="mt-1 text-xs text-slate-500">Manual, Paper Auto, GTT Assisted and live execution are kept separate so simulated evidence cannot inflate real-money results.</p><div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{scorecards.map((card) => <div key={card.source} className="rounded-lg border border-slate-200 p-3"><p className="text-xs font-semibold uppercase text-slate-500">{card.source.replaceAll("_", " ")}</p><p className={`mt-1 text-lg font-bold ${num(card.net_pnl_inr) > 0 ? "text-emerald-700" : num(card.net_pnl_inr) < 0 ? "text-red-700" : "text-slate-900"}`}>{money(card.net_pnl_inr)}</p><p className="mt-1 text-xs text-slate-500">{card.closed_trades} closed · {card.open_trades} open · {card.expectancy_r === null ? "expectancy unavailable" : `${signed(card.expectancy_r, "R")} expectancy`} · {card.win_rate_percentage === null ? "win rate unavailable" : `${num(card.win_rate_percentage).toFixed(0)}% wins`}</p></div>)}</div></div> : null}
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

        <section id="automation" className="mt-8 scroll-mt-6" aria-labelledby="automation-title">
            <div className="mb-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Execution control centre</p><h2 id="automation-title" className="mt-1 text-xl font-semibold">Automation and Kite</h2><p className="mt-1 text-sm text-slate-500">Start with the connection, then use only the execution path supported by your Kite plan. Advanced rollout evidence is collapsed at the end.</p></div>
            <KiteConnectionCard connection={kiteConnection} configured={kiteConfiguration.configured} worker={kiteWorker} workerFresh={kiteWorkerFresh} account={kiteAccount} reconciliation={kiteReconciliation} reconciliationRows={kiteReconciliationRows} />
            <GttAssistedCard controls={automation} worker={gttWorker} workerFresh={gttWorkerFresh} entries={gttEntries} kiteConnected={kiteConnected} />
            <PaperAutoCard controls={automation} worker={paperWorker} workerFresh={paperWorkerFresh} events={paperEvents} kiteConnected={kiteConnected} today={currentIndiaDate} />
            <LiveExecutionCard controls={automation} worker={liveWorker} workerFresh={liveWorkerFresh} intents={liveIntents} orders={liveOrders} protections={liveProtections} riskLocks={liveRiskLocks} today={currentIndiaDate} />
            <details className="rounded-xl border border-slate-200 bg-white p-4"><summary className="cursor-pointer font-semibold">Advanced rollout readiness and limits</summary><div className="mt-4"><SwingRolloutReadinessCard controls={automation} readiness={readiness} /></div></details>
        </section>

        <section id="settings" className="mt-8 scroll-mt-6 rounded-xl border border-slate-200 bg-white p-5">
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

function GttAssistedCard({ controls, worker, workerFresh, entries, kiteConnected }: {
    controls: AutomationControls;
    worker: KiteWorkerHeartbeat | null;
    workerFresh: boolean;
    entries: GttAssistedEntry[];
    kiteConnected: boolean;
}) {
    const activeEntries = entries.filter((entry) => ["pending_submission", "active", "triggered", "order_open", "cancel_requested"].includes(entry.status));
    const workerReady = Boolean(workerFresh && worker?.worker_status === "healthy" && worker.kite_session_healthy);
    const canEnable = controls.market_data_plan === "personal" && Boolean(controls.ddpi_confirmed_at) && kiteConnected && !controls.emergency_stop_active;
    return <section className="mb-6 rounded-xl border border-blue-200 bg-white p-5" aria-labelledby="gtt-assisted-title">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex gap-3"><div className="rounded-lg bg-blue-50 p-2 text-blue-700"><ShieldCheck className="h-5 w-5" /></div><div><h2 id="gtt-assisted-title" className="text-lg font-semibold">Personal Free · GTT Assisted</h2><p className="mt-1 text-sm text-slate-500">Explicitly approved, same-session broker-hosted entry triggers with automatic OCO protection after a confirmed fill.</p></div></div>
            <span className={`w-fit rounded-full border px-3 py-1 text-xs font-semibold uppercase ${controls.gtt_assisted_enabled ? "border-blue-200 bg-blue-50 text-blue-800" : "border-slate-200 bg-slate-50 text-slate-700"}`}>{controls.gtt_assisted_enabled ? "Enabled" : "Disabled"}</span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <SmallMetric label="Market-data plan" value={controls.market_data_plan === "personal" ? "Personal Free" : "Connect"} />
            <SmallMetric label="GTT worker" value={!worker ? "Not installed" : !workerFresh ? "Heartbeat stale" : worker.worker_status} />
            <SmallMetric label="Kite session" value={workerFresh && worker?.kite_session_healthy ? "Validated" : "Unavailable"} />
            <SmallMetric label="Price monitoring" value="Handled by Zerodha GTT" />
            <SmallMetric label="Active entries" value={String(activeEntries.length)} />
        </div>
        {controls.gtt_assisted_enabled && !workerReady ? <div role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p className="font-semibold">GTT Assisted is enabled, but its VPS worker is not ready</p><p className="mt-1">Do not approve an entry until the worker is healthy. Existing broker GTTs must be checked directly in Kite whenever this heartbeat is stale or blocked.</p></div> : null}
        {activeEntries.some((entry) => entry.status === "cancel_requested") ? <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900"><p className="font-semibold">Broker cancellation is pending</p><p className="mt-1">Treat the entry trigger as active until the VPS confirms that Kite cancelled it.</p></div> : null}
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
            <p className="font-semibold">How this free-plan path behaves</p>
            <p className="mt-1">Between 09:20 and 15:05 IST, enter the current LTP shown in Kite. It must still be below the candidate trigger. Zerodha watches the trigger; an entry uses the candidate maximum price as its limit. After a real fill, the VPS installs an OCO stop and 2R target. Unfilled entry GTTs are cancelled at 15:20 IST and never intentionally carried overnight.</p>
        </div>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            {!controls.gtt_assisted_enabled ? <form action={configureSwingGttAssisted}><input type="hidden" name="action" value="enable" /><ConfirmSubmitButton confirmation="Enable Personal Free GTT Assisted? Every entry still needs your approval, while the VPS may submit and cancel broker GTTs and install protective exits." pendingText="Enabling GTT Assisted..." disabled={!canEnable}>Enable GTT Assisted</ConfirmSubmitButton></form> : <form action={configureSwingGttAssisted}><input type="hidden" name="action" value="disable" /><ConfirmSubmitButton confirmation="Disable new GTT Assisted entries? Submitted entry triggers will be cancelled by the VPS; existing position protection will remain." pendingText="Disabling GTT Assisted..." className="border-red-200 text-red-700 hover:bg-red-50">Disable and cancel entries</ConfirmSubmitButton></form>}
            {!canEnable && !controls.gtt_assisted_enabled ? <p className="text-xs text-amber-800">Personal Free, DDPI confirmation, a current Kite session and a cleared emergency stop are required.</p> : <p className="text-xs text-slate-500">This switch does not unlock Assisted Live, Live Auto or regular-order submission.</p>}
        </div>
        <details open={activeEntries.length > 0} className="mt-4 rounded-lg border border-slate-200 p-4">
            <summary className="cursor-pointer text-sm font-semibold">Entry GTT activity ({entries.length})</summary>
            {entries.length ? <div className="mt-3 space-y-2">{entries.map((entry) => <div key={entry.id} className="flex flex-col gap-3 rounded-lg bg-slate-50 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"><div><p className="font-semibold">{entry.symbol} · {entry.quantity} share{entry.quantity === 1 ? "" : "s"} · trigger {decimalMoney(entry.entry_trigger)} · limit {decimalMoney(entry.maximum_entry)}</p><p className="mt-1 text-xs text-slate-500">{entry.status.replaceAll("_", " ")} · Kite trigger {entry.broker_trigger_id ?? "not submitted"} · cancel by {dateTime(entry.cancel_after)}</p>{entry.failure_reason ? <p className="mt-1 text-xs text-red-700">{entry.failure_reason}</p> : null}</div>{["pending_submission", "active", "triggered", "order_open"].includes(entry.status) ? <form action={cancelSwingGttAssistedEntry}><input type="hidden" name="entry_id" value={entry.id} /><ConfirmSubmitButton confirmation="Cancel this entry GTT? Treat it as active until Kite cancellation is confirmed." pendingText="Requesting cancellation..." className="border-red-200 text-red-700 hover:bg-red-50">Cancel entry GTT</ConfirmSubmitButton></form> : null}</div>)}</div> : <p className="mt-3 text-sm text-slate-500">No GTT Assisted entry has been requested.</p>}
        </details>
    </section>;
}

function LiveExecutionCard({ controls, worker, workerFresh, intents, orders, protections, riskLocks, today }: {
    controls: AutomationControls;
    worker: KiteWorkerHeartbeat | null;
    workerFresh: boolean;
    intents: LiveOrderIntent[];
    orders: LiveBrokerOrder[];
    protections: LiveProtection[];
    riskLocks: LiveRiskLock[];
    today: string;
}) {
    const mode = controls.automation_mode;
    const liveMode = mode === "assisted_live" || mode === "live_auto";
    const armed = liveMode && controls.new_entries_enabled && controls.armed_nse_session === today && !controls.emergency_stop_active;
    const pendingApprovals = intents.filter((intent) => intent.automation_mode === "assisted_live" && intent.status === "pending" && intent.approval_status === "pending");
    const activeOrders = orders.filter((order) => !["COMPLETE", "CANCELLED", "REJECTED"].includes(order.status.toUpperCase()));
    const unhealthyProtection = protections.filter((protection) => ["failed", "rejected"].includes(protection.status));
    const status = armed ? `${mode === "live_auto" ? "Live Auto" : "Assisted Live"} armed` : liveMode ? "New entries paused" : "Not armed";
    return <section className="mb-6 rounded-xl border border-slate-200 bg-white p-5" aria-labelledby="live-execution-title">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex gap-3"><div className="rounded-lg bg-red-50 p-2 text-red-700"><Activity className="h-5 w-5" /></div><div><h2 id="live-execution-title" className="text-lg font-semibold">Assisted Live and Live Auto</h2><p className="mt-1 text-sm text-slate-500">Kite orders are submitted only by the static-IP VPS after database approval, runtime revalidation and idempotent recovery.</p></div></div>
            <span className={`w-fit rounded-full border px-3 py-1 text-xs font-semibold uppercase ${armed ? "border-red-200 bg-red-50 text-red-800" : "border-slate-200 bg-slate-50 text-slate-700"}`}>{status}</span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <SmallMetric label="VPS live worker" value={!worker ? "Not installed" : !workerFresh ? "Heartbeat stale" : worker.worker_status} />
            <SmallMetric label="Quote health" value={controls.market_data_plan === "personal" ? "Unavailable · Personal Free" : workerFresh && worker?.quote_stream_healthy ? "Fresh" : "Idle / unavailable"} />
            <SmallMetric label="Assisted Live" value={controls.assisted_live_unlocked && controls.broker_execution_enabled ? "Unlocked" : "Locked"} />
            <SmallMetric label="Live Auto" value={controls.live_auto_unlocked && controls.broker_execution_enabled ? "Unlocked" : "Locked"} />
            <SmallMetric label="Active protection" value={`${protections.filter((row) => row.status === "active").length} GTT`} />
        </div>
        {!controls.broker_execution_enabled ? <div role="status" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p className="font-semibold">Broker execution is intentionally locked</p><p className="mt-1">The Phase 8/9 code is present, but no live order can be claimed until the service-role rollout lock and VPS write gate are both enabled during configuration.</p></div> : null}
        {unhealthyProtection.length ? <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900"><p className="font-semibold">Protective order attention required</p><p className="mt-1">{unhealthyProtection.length} protective order record(s) are failed or rejected. New entries should remain blocked until broker protection is restored.</p></div> : null}
        {riskLocks.length ? <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900"><p className="font-semibold">Active execution risk locks</p><div className="mt-2 space-y-2">{riskLocks.map((lock) => <div key={lock.id} className="flex flex-col gap-2 rounded-md bg-white/70 p-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium">{lock.control_type.replaceAll("_", " ")}</p><p className="text-xs">{lock.reason} · {dateTime(lock.activated_at)}</p></div><form action={clearSwingRiskControl}><input type="hidden" name="activation_id" value={lock.id} /><ConfirmSubmitButton confirmation="Clear this risk lock after verifying the underlying broker/worker issue? This will not re-arm entries." pendingText="Clearing lock...">Clear after review</ConfirmSubmitButton></form></div>)}</div></div> : null}

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-slate-200 p-4"><h3 className="font-semibold">Assisted Live</h3><p className="mt-1 text-sm text-slate-600">A valid trigger creates a five-minute proposal. You approve it; the VPS then rechecks price, risk, funds, reconciliation and duplicates before submission.</p><form action={configureSwingLiveMode} className="mt-3"><input type="hidden" name="action" value="arm" /><input type="hidden" name="mode" value="assisted_live" /><ConfirmSubmitButton confirmation="Arm Assisted Live for today? Each entry still requires your approval and final VPS revalidation." pendingText="Arming Assisted Live..." disabled={!controls.assisted_live_unlocked || !controls.broker_execution_enabled}>Arm Assisted Live today</ConfirmSubmitButton></form></div>
            <div className="rounded-lg border border-slate-200 p-4"><h3 className="font-semibold">Capped Live Auto</h3><p className="mt-1 text-sm text-slate-600">Uses the same trigger and revalidation path without per-entry approval, capped at one position, one entry/day, {money(controls.live_max_deployed_inr)} deployed and {money(controls.live_daily_loss_limit_inr)} daily lock.</p><form action={configureSwingLiveMode} className="mt-3"><input type="hidden" name="action" value="arm" /><input type="hidden" name="mode" value="live_auto" /><ConfirmSubmitButton confirmation="Arm Live Auto for today's NSE session? Qualified orders may be sent without another approval." pendingText="Arming Live Auto..." className="border-red-200 text-red-700 hover:bg-red-50" disabled={!controls.live_auto_unlocked || !controls.broker_execution_enabled}>Arm Live Auto today</ConfirmSubmitButton></form></div>
        </div>
        {liveMode ? <div className="mt-3 flex flex-col gap-3 sm:flex-row"><form action={configureSwingLiveMode}><input type="hidden" name="action" value="pause" /><input type="hidden" name="mode" value={mode} /><ConfirmSubmitButton confirmation="Pause new live entries? Existing reconciliation and broker-side protection will continue." pendingText="Pausing live entries...">Pause new entries</ConfirmSubmitButton></form><form action={configureSwingLiveMode}><input type="hidden" name="action" value="advisory" /><input type="hidden" name="mode" value={mode} /><ConfirmSubmitButton confirmation="Return to Advisory mode? Existing broker-side protection will remain active." pendingText="Returning to Advisory...">Use Advisory mode</ConfirmSubmitButton></form></div> : null}

        <details open={pendingApprovals.length > 0} className="mt-4 rounded-lg border border-slate-200 p-4"><summary className="cursor-pointer text-sm font-semibold">Assisted Live approvals ({pendingApprovals.length})</summary>{pendingApprovals.length ? <div className="mt-3 space-y-3">{pendingApprovals.map((intent) => <div key={intent.id} className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm"><div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-semibold">{intent.transaction_type} {intent.quantity} {intent.symbol}</p><p className="mt-1 text-xs text-slate-600">Limit {intent.limit_price === null ? "N/A" : decimalMoney(intent.limit_price)} · expires {dateTime(intent.approval_expires_at)}</p></div><div className="flex gap-2"><form action={decideSwingAssistedIntent}><input type="hidden" name="intent_id" value={intent.id} /><input type="hidden" name="action" value="approve" /><ConfirmSubmitButton confirmation={`Approve ${intent.transaction_type} ${intent.quantity} ${intent.symbol}? The VPS will revalidate before submission.`} pendingText="Approving...">Approve</ConfirmSubmitButton></form><form action={decideSwingAssistedIntent}><input type="hidden" name="intent_id" value={intent.id} /><input type="hidden" name="action" value="reject" /><ConfirmSubmitButton confirmation="Reject this proposal? No broker order will be submitted." pendingText="Rejecting..." className="border-red-200 text-red-700 hover:bg-red-50">Reject</ConfirmSubmitButton></form></div></div></div>)}</div> : <p className="mt-3 text-sm text-slate-500">No Assisted Live proposal is waiting for approval.</p>}</details>
        <details className="mt-3 rounded-lg border border-slate-200 p-4"><summary className="cursor-pointer text-sm font-semibold">Broker timeline ({orders.length} orders · {activeOrders.length} active)</summary>{orders.length ? <div className="mt-3 space-y-2">{orders.map((order) => <div key={order.id} className="flex flex-col gap-1 rounded-lg bg-slate-50 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"><span><strong>{order.broker_order_id}</strong> · {order.status} · {order.filled_quantity}/{order.quantity} filled</span><span className="text-xs text-slate-500">{order.average_price === null ? "No fill" : decimalMoney(order.average_price)} · {dateTime(order.updated_at)}</span></div>)}</div> : <p className="mt-3 text-sm text-slate-500">No live broker order has been recorded.</p>}</details>
    </section>;
}

function SwingRolloutReadinessCard({ controls, readiness }: {
    controls: AutomationControls;
    readiness: RolloutReadiness;
}) {
    const phaseStatus = (ready: boolean, locked: boolean) => ready ? "Ready" : locked ? "Locked" : "Collecting evidence";
    return <section className="mb-6 rounded-xl border border-slate-200 bg-white p-5" aria-labelledby="rollout-readiness-title">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex gap-3">
                <div className="rounded-lg bg-emerald-50 p-2 text-emerald-700"><ShieldCheck className="h-5 w-5" /></div>
                <div><h2 id="rollout-readiness-title" className="text-lg font-semibold">Execution rollout readiness</h2><p className="mt-1 text-sm text-slate-500">Forward Paper Auto evidence and live prerequisites. This scorecard cannot unlock broker execution.</p></div>
            </div>
            <span className={`w-fit rounded-full border px-3 py-1 text-xs font-semibold uppercase ${controls.broker_execution_enabled ? "border-red-200 bg-red-50 text-red-800" : "border-slate-200 bg-slate-50 text-slate-700"}`}>{controls.broker_execution_enabled ? "VPS execution enabled" : "Live orders locked"}</span>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <SmallMetric label="Phase 7 · Paper validation" value={phaseStatus(readiness.phase7_ready, false)} />
            <SmallMetric label="Phase 8 · Assisted Live" value={phaseStatus(readiness.phase8_ready, readiness.live_modes_locked)} />
            <SmallMetric label="Phase 9 · Live Auto" value={phaseStatus(readiness.phase9_ready, !controls.live_auto_unlocked)} />
        </div>

        {controls.market_data_plan === "personal" ? <div role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p className="font-semibold">Kite Personal Free blocks real-time validation</p><p className="mt-1">Order, GTT and account APIs are available, but the official live quote entitlement is not. Quote-driven Paper Auto and both full live modes remain blocked; the separate GTT Assisted path can be used after its own checks pass.</p></div> : null}

        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {readiness.checks.filter((check) => check.key !== "credentials").map((check) => <div key={check.key} className={`flex gap-2 rounded-lg border p-3 text-sm ${check.passed ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-slate-200 bg-slate-50 text-slate-700"}`}>
                {check.passed ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <Clock3 className="mt-0.5 h-4 w-4 shrink-0" />}
                <p>{check.reason}</p>
            </div>)}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <SmallMetric label="Fresh-quote sessions" value={`${readiness.counts.paper_quote_sessions}/5`} />
            <SmallMetric label="Paper entries" value={`${readiness.counts.paper_entry_events}/3`} />
            <SmallMetric label="Paper exits" value={`${readiness.counts.paper_exit_events}/2`} />
            <SmallMetric label="Assisted closed trades" value={`${readiness.counts.assisted_live_closed_trades}/3`} />
            <SmallMetric label="Active risk locks" value={String(readiness.counts.active_risk_locks)} />
        </div>

        <details className="mt-4 rounded-lg border border-slate-200 p-4">
            <summary className="cursor-pointer text-sm font-semibold">Readiness confirmations and initial live limits</summary>
            <form action={saveSwingLiveReadiness} className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <label className="flex items-center gap-3 rounded-lg border border-slate-200 p-3 text-sm font-medium text-slate-700"><input type="checkbox" name="ddpi_confirmed" defaultChecked={Boolean(controls.ddpi_confirmed_at)} className="h-4 w-4" />DDPI is enabled</label>
                <label className="block text-sm font-medium text-slate-700">Kite market-data plan{controls.gtt_assisted_enabled ? <><input type="hidden" name="market_data_plan" value={controls.market_data_plan} /><select value={controls.market_data_plan} disabled className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-100 px-3 py-2"><option value="personal">Personal Free</option><option value="connect">Connect ₹500</option></select><span className="mt-1 block text-xs font-normal text-amber-700">Disable GTT Assisted before changing plans.</span></> : <select name="market_data_plan" defaultValue={controls.market_data_plan} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2"><option value="personal">Personal Free</option><option value="connect">Connect ₹500</option></select>}</label>
                <NumberField name="live_max_open_positions" label="Initial maximum live positions" value={controls.live_max_open_positions} min={1} max={2} step={1} />
                <NumberField name="live_max_new_entries_per_day" label="Initial new live entries/day" value={controls.live_max_new_entries_per_day} min={1} max={2} step={1} />
                <NumberField name="live_max_deployed_inr" label="Initial maximum deployed (INR)" value={num(controls.live_max_deployed_inr)} min={500} step={500} />
                <NumberField name="live_daily_loss_limit_inr" label="Daily new-entry loss lock (INR)" value={num(controls.live_daily_loss_limit_inr)} min={10} step={10} />
                <NumberField name="live_risk_per_trade_percentage" label="Maximum live risk/trade (%)" value={num(controls.live_risk_per_trade_percentage)} min={0.1} max={0.5} step={0.05} />
                <NumberField name="live_amber_risk_multiplier" label="AMBER risk multiplier" value={num(controls.live_amber_risk_multiplier)} min={0.1} max={0.5} step={0.05} />
                <div className="sm:col-span-2 lg:col-span-3"><FormSubmitButton pendingText="Saving readiness settings...">Save readiness settings</FormSubmitButton></div>
            </form>
        </details>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            {!controls.emergency_stop_active ? <form action={setSwingEmergencyStop}><input type="hidden" name="action" value="activate" /><ConfirmSubmitButton confirmation="Activate the emergency stop? New entries will be disarmed, while existing protective exits remain unchanged." pendingText="Activating emergency stop..." className="border-red-200 text-red-700 hover:bg-red-50">Emergency stop new entries</ConfirmSubmitButton></form> : <form action={setSwingEmergencyStop}><input type="hidden" name="action" value="clear" /><ConfirmSubmitButton confirmation="Clear the emergency stop? New entries will remain disarmed until a mode is explicitly armed." pendingText="Clearing emergency stop...">Clear emergency stop</ConfirmSubmitButton></form>}
            <p className="text-xs text-slate-500">Emergency stop affects new entries only. Existing position monitoring and broker-side protection must continue.</p>
        </div>
    </section>;
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
                <div><h2 id="paper-auto-title" className="text-lg font-semibold">Paper Auto</h2><p className="mt-1 text-sm text-slate-500">Production Kite quotes, simulated fills, realistic costs and automated paper stops. This mode never submits broker orders.</p></div>
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
        {controls.market_data_plan === "personal" ? <div role="status" className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900"><p className="font-semibold">Paper Auto requires Kite Connect</p><p className="mt-1">Personal Free has no API quote feed. Use GTT Assisted for explicitly approved real entries, or upgrade later to collect live-quote Paper Auto evidence.</p></div> : null}
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
            <div className="flex items-end"><ConfirmSubmitButton confirmation="Arm Paper Auto for today's session? This can create simulated paper trades, but no broker orders." pendingText="Arming Paper Auto..." className="w-full bg-violet-700 text-white hover:bg-violet-800" disabled={!kiteConnected || controls.market_data_plan !== "connect"}>{armed ? "Save and re-arm today" : "Arm Paper Auto today"}</ConfirmSubmitButton></div>
        </form>

        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
            {controls.automation_mode === "paper_auto" ? <form action={configureSwingPaperAuto}><input type="hidden" name="action" value="pause" /><input type="hidden" name="paper_slippage_bps" value={num(controls.paper_slippage_bps)} /><input type="hidden" name="paper_max_new_entries_per_day" value={controls.paper_max_new_entries_per_day} /><ConfirmSubmitButton confirmation="Pause only new Paper Auto entries? Existing simulated positions will keep their stop and exit monitoring." pendingText="Pausing entries...">Pause new entries</ConfirmSubmitButton></form> : null}
            {controls.automation_mode === "paper_auto" ? <form action={configureSwingPaperAuto}><input type="hidden" name="action" value="advisory" /><input type="hidden" name="paper_slippage_bps" value={num(controls.paper_slippage_bps)} /><input type="hidden" name="paper_max_new_entries_per_day" value={controls.paper_max_new_entries_per_day} /><ConfirmSubmitButton confirmation="Return new entries to manual Advisory mode? Existing paper records will remain in the journal." pendingText="Switching to Advisory...">Use Advisory mode</ConfirmSubmitButton></form> : null}
            <p className="flex items-center gap-2 text-xs text-slate-500"><ShieldCheck className="h-4 w-4 text-emerald-600" />Paper Auto has no broker-write path. Live modes use a separate locked VPS worker.</p>
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
                <div><h2 id="kite-connection-title" className="text-lg font-semibold">Kite connection and VPS verification</h2><p className="mt-1 text-sm text-slate-500">The read-only worker verifies the account and reconciles live Swing Lab positions. Broker writes, when unlocked, use a separate static-IP live worker.</p></div>
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
                    <OperationalRow label="Quote stream" value="Handled by Paper/Live worker" />
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
            <p className="flex items-center gap-2 text-xs text-slate-500"><ShieldCheck className="h-4 w-4 text-emerald-600" />Encrypted token · daily expiry · read-only reconciliation · separate locked execution worker</p>
        </div>
        {connection?.broker_user_id ? <details className="mt-4 rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer text-xs font-medium text-slate-600">Connect a different Kite account</summary><p className="mt-2 text-xs text-slate-500">For safety, the first verified broker user is pinned. Reset is allowed only after every execution mode is disarmed and no live order, position, entry GTT, or protection remains.</p><form action={resetKiteBrokerIdentity} className="mt-3"><ConfirmSubmitButton confirmation="Reset the pinned Kite account identity? This removes the stored session and requires a fresh explicit connection." pendingText="Resetting broker identity..." className="border-red-200 text-red-700 hover:bg-red-50">Reset pinned account</ConfirmSubmitButton></form></details> : null}
    </section>;
}

function OperationalRow({ label, value, good }: { label: string; value: string; good?: boolean }) {
    const tone = good === undefined ? "text-slate-700" : good ? "text-emerald-700" : "text-amber-700";
    return <div className="flex items-start justify-between gap-3"><dt className="text-slate-500">{label}</dt><dd className={`text-right font-medium capitalize ${tone}`}>{value}</dd></div>;
}

function CandidateCard({ candidate, settings, today, entryAllowed, entryBlockedReason, carriedForward, gttAssistedAvailable, hasOpenGtt }: { candidate: Candidate; settings: Settings; today: string; entryAllowed: boolean; entryBlockedReason: string | null; carriedForward: boolean; gttAssistedAvailable: boolean; hasOpenGtt: boolean }) {
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
        <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600"><p><strong>Planned risk:</strong> {money(risk)} · <strong>Risk/share:</strong> {decimalMoney(candidate.risk_per_share)}. Manual and quote-driven modes follow protective-stop, trailing-stop and time-review rules. Personal Free GTT Assisted uses a fixed 2R OCO target because it has no live quote feed.</p>{stringList(candidate.reasons).length ? <ul className="mt-2 space-y-1 text-xs">{stringList(candidate.reasons).map((reason) => <li key={reason}>• {reason}</li>)}</ul> : null}</div>
        {hasOpenGtt ? <div role="status" className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900"><p className="font-semibold">GTT Assisted owns this candidate</p><p className="mt-1">Do not enter it manually. Review or cancel the broker trigger in the GTT Assisted activity panel.</p></div> : null}
        {entryAllowed && gttAssistedAvailable && !testOnly && !hasOpenGtt ? <details className="mt-4 rounded-lg border border-blue-200 p-3"><summary className="cursor-pointer text-sm font-semibold text-blue-900">Approve a Personal Free entry GTT</summary><form action={createSwingGttAssistedEntry} className="mt-4 space-y-3"><input type="hidden" name="candidate_id" value={candidate.id} /><label className="block text-sm font-medium text-slate-700">Current LTP shown in Kite<input name="current_ltp" type="number" min={num(candidate.initial_stop) + 0.01} max={num(candidate.entry_trigger) - 0.01} step="0.01" required placeholder={`Must be below ${num(candidate.entry_trigger).toFixed(2)}`} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 outline-none focus:ring-2 focus:ring-blue-300" /></label><p className="text-xs text-slate-500">Enter this manually from Kite between 09:20 and 15:05 IST. The database calculates the final quantity using the lower of suggested quantity, available cash, deployment cap and stop-risk limit.</p><ConfirmSubmitButton confirmation={`Approve a broker-hosted BUY GTT for ${candidate.symbol}? Zerodha may place a limit order when ${decimalMoney(candidate.entry_trigger)} is reached, capped at ${decimalMoney(candidate.maximum_entry)}.`} pendingText="Approving entry GTT..." className="w-full border-blue-300 bg-blue-700 text-white hover:bg-blue-800">Approve entry GTT</ConfirmSubmitButton></form></details> : null}
        {entryAllowed && triggered && !hasOpenGtt ? <details className="mt-4 rounded-lg border border-emerald-200 p-3"><summary className="cursor-pointer text-sm font-semibold text-emerald-900">Confirm my actual broker fill</summary><form action={confirmSwingEntry} className="mt-4 grid gap-3 sm:grid-cols-2"><input type="hidden" name="candidate_id" value={candidate.id} /><NumberField name="entry_price" label={testOnly ? "Paper fill price" : "Actual fill price"} value={num(candidate.entry_trigger)} min={0.01} step={0.01} /><NumberField name="quantity" label="Actual quantity" value={suggestedQuantity} min={1} step={1} /><DateField name="entry_date" label="Entry date" value={today} />{testOnly ? <><input type="hidden" name="trade_mode" value="paper" /><div className="rounded-lg bg-violet-50 p-3 text-sm font-medium text-violet-800">Trade mode: Paper only</div></> : <label className="block text-sm font-medium text-slate-700">Trade mode<select name="trade_mode" defaultValue={settings.paper_mode ? "paper" : "live"} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2"><option value="paper">Paper</option><option value="live">Live</option></select></label>}<label className="block text-sm font-medium text-slate-700 sm:col-span-2">Note<input name="notes" placeholder="Optional entry note" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" /></label><div className="sm:col-span-2"><FormSubmitButton pendingText="Confirming entry...">{testOnly ? "Start test paper tracking" : "Start tracking actual entry"}</FormSubmitButton></div></form></details> : entryAllowed && !triggered && !hasOpenGtt ? <div role="status" className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900"><p className="font-semibold">Ready setup — waiting for trigger</p><p className="mt-1">The morning monitor must observe the entry trigger before a manual fill can be recorded. You may still approve a same-session GTT Assisted trigger above.</p></div> : !hasOpenGtt ? <div role="status" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p className="font-semibold">Entry confirmation unavailable</p><p className="mt-1">{entryBlockedReason ?? "Wait for a valid fresh scan before entering this candidate."}</p></div> : null}
        {!hasOpenGtt ? <form action={skipSwingCandidate} className="mt-3 flex flex-col gap-2 sm:flex-row"><input type="hidden" name="candidate_id" value={candidate.id} /><input name="reason" placeholder="Optional skip reason" className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm" /><ConfirmSubmitButton confirmation={`Skip ${candidate.symbol}?`} pendingText="Skipping...">Skip candidate</ConfirmSubmitButton></form> : null}
    </article>;
}

function OpenTradeCard({ trade, today }: { trade: Trade; today: string }) {
    const corporateActionReview = trade.corporate_action_review_required;
    const current = trade.current_price === null ? num(trade.entry_price) : num(trade.current_price);
    const pnl = trade.unrealized_pnl_inr === null ? (current - num(trade.entry_price)) * trade.quantity : num(trade.unrealized_pnl_inr);
    const r = trade.unrealized_r_multiple === null ? pnl / Math.max(num(trade.planned_risk_inr), 0.01) : num(trade.unrealized_r_multiple);
    return <article className={`rounded-xl border bg-white p-5 ${corporateActionReview ? "border-amber-300 ring-1 ring-amber-100" : trade.status === "exit_pending" ? "border-red-300 ring-1 ring-red-100" : "border-slate-200"}`}>
        <div className="flex items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-bold">{trade.symbol}</h3><span className={`rounded-full px-2.5 py-1 text-xs font-semibold uppercase ${trade.status === "exit_pending" ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>{trade.status.replace("_", " ")}</span><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium uppercase text-slate-600">{trade.trade_mode}</span>{trade.execution_source === "paper_auto" ? <span className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-medium uppercase text-violet-700">Paper Auto</span> : trade.execution_source === "gtt_assisted" ? <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium uppercase text-blue-700">GTT Assisted</span> : null}</div><p className="mt-1 text-sm text-slate-600">{trade.quantity} shares · entered {date(trade.entry_date)}</p></div><div className="text-right">{corporateActionReview ? <><p className="text-lg font-bold text-amber-700">Monitoring paused</p><p className="text-xs text-slate-500">P&L basis requires reconciliation</p></> : <><p className={`text-xl font-bold ${pnl > 0 ? "text-emerald-700" : pnl < 0 ? "text-red-700" : "text-slate-950"}`}>{money(pnl)}</p><p className="text-xs font-medium text-slate-500">{signed(r, "R")}</p></>}</div></div>
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

function QuickState({ label, value, tone }: { label: string; value: string; tone?: "good" }) {
    return <div className={`rounded-lg border px-4 py-3 ${tone === "good" ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-white"}`}><p className="text-xs text-slate-500">{label}</p><p className={`mt-1 text-xl font-bold ${tone === "good" ? "text-emerald-700" : "text-slate-950"}`}>{value}</p></div>;
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
