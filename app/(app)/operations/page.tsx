import { redirect } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock3 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { getIndiaDate, getLatestExpectedDailyRunDate, getLatestExpectedWeekdayRunDate } from "@/lib/performance";

type Health = "healthy" | "warning" | "failed";
type Run = { as_of: string; status: string; contract_version: string | null; publication_status: string | null; data_issues: unknown };

function issueCount(value: unknown) {
    return Array.isArray(value) ? value.length : 0;
}

function time(value: string | null | undefined) {
    if (!value) return "Never";
    return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(value));
}

function runHealth(run: Run | null, expectedDate: string): Health {
    if (!run || getIndiaDate(new Date(run.as_of)) < expectedDate) return "failed";
    if (run.status === "failed" || run.publication_status !== "published") return "failed";
    return run.status === "partial" || issueCount(run.data_issues) > 0 ? "warning" : "healthy";
}

export default async function OperationsPage() {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) redirect("/auth/login");

    const [portfolioResult, scanResult, monitorResult, newsResult, sourcesResult, deliveriesResult] = await Promise.all([
        supabase.from("market_signal_runs").select("as_of, status, contract_version, publication_status, data_issues").eq("user_id", user.id).order("as_of", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("swing_scan_runs").select("as_of, status, contract_version, publication_status, data_issues").eq("user_id", user.id).order("as_of", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("swing_monitor_runs").select("as_of, status, contract_version, publication_status, data_issues").eq("user_id", user.id).order("as_of", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("news_pipeline_runs").select("as_of, status, contract_version, publication_status, data_issues").eq("user_id", user.id).order("as_of", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("news_sources").select("id, name, last_success_at, last_error, consecutive_failures").eq("user_id", user.id).eq("is_active", true).order("name"),
        supabase.from("analyzer_notification_deliveries").select("id, channel, status, attempt_count, claimed_at, error_message").eq("user_id", user.id).in("status", ["claimed", "uncertain"]).order("claimed_at", { ascending: false }).limit(50),
    ]);
    const queryError = portfolioResult.error || scanResult.error || monitorResult.error || newsResult.error || sourcesResult.error || deliveriesResult.error;
    if (queryError) return <main className="mx-auto max-w-5xl px-4 py-8"><PageHeader title="Analyzer Operations" description="Automation and publication health." /><div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-5 text-red-900">{queryError.message}</div></main>;

    const now = new Date();
    const portfolio = portfolioResult.data as Run | null;
    const scan = scanResult.data as Run | null;
    const monitor = monitorResult.data as Run | null;
    const news = newsResult.data as Run | null;
    const newsAgeMinutes = news ? (now.getTime() - new Date(news.as_of).getTime()) / 60000 : Number.POSITIVE_INFINITY;
    const newsHealth: Health = !news || newsAgeMinutes > 100 || news.status === "failed" || news.publication_status !== "published"
        ? "failed"
        : news.status === "partial" || issueCount(news.data_issues) > 0 ? "warning" : "healthy";
    const items = [
        { name: "Portfolio Analyzer", cadence: "Daily at 8:00 AM IST", run: portfolio, expected: getLatestExpectedDailyRunDate(8, 0, 120, now), health: runHealth(portfolio, getLatestExpectedDailyRunDate(8, 0, 120, now)), href: "/market-intelligence" },
        { name: "Swing end-of-day", cadence: "Weekdays at 5:30 PM IST", run: scan, expected: getLatestExpectedWeekdayRunDate(17, 30, 90, now), health: runHealth(scan, getLatestExpectedWeekdayRunDate(17, 30, 90, now)), href: "/swing-lab" },
        { name: "Swing morning monitor", cadence: "Weekdays at 9:25 AM IST", run: monitor, expected: getLatestExpectedWeekdayRunDate(9, 25, 95, now), health: runHealth(monitor, getLatestExpectedWeekdayRunDate(9, 25, 95, now)), href: "/swing-lab" },
        { name: "News & Events", cadence: "Hourly at minute 17", run: news, expected: "Within the last 100 minutes", health: newsHealth, href: "/news-events" },
    ];
    const unhealthySources = (sourcesResult.data ?? []).filter((source) => source.last_error || Number(source.consecutive_failures) > 0);
    const deliveries = deliveriesResult.data ?? [];
    const healthyCount = items.filter((item) => item.health === "healthy").length;

    return <main><div className="mx-auto max-w-6xl px-4 py-8">
        <PageHeader title="Analyzer Operations" description="One place to verify scheduled runs, data-source health, publication contracts and unresolved deliveries." />
        <section className="grid gap-4 sm:grid-cols-3"><Metric label="Healthy workflows" value={`${healthyCount}/${items.length}`} /><Metric label="Source problems" value={String(unhealthySources.length)} warn={unhealthySources.length > 0} /><Metric label="Unresolved deliveries" value={String(deliveries.length)} warn={deliveries.length > 0} /></section>
        <section className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white"><div className="border-b border-slate-100 px-5 py-4"><h2 className="text-lg font-semibold">Workflow publications</h2><p className="mt-1 text-sm text-slate-500">Expected times include a grace period. This confirms Tracker publication, not GitHub’s internal job state.</p></div><div className="divide-y divide-slate-100">{items.map((item) => <HealthRow key={item.name} {...item} />)}</div></section>
        <section className="mt-6 grid gap-6 lg:grid-cols-2"><div className="rounded-xl border border-slate-200 bg-white p-5"><h2 className="text-lg font-semibold">Source health</h2>{unhealthySources.length ? <div className="mt-4 space-y-3">{unhealthySources.map((source) => <div key={source.id} className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p className="font-semibold">{source.name}</p><p className="mt-1">{source.last_error ?? `${source.consecutive_failures} consecutive failures`}</p><p className="mt-1 text-xs">Last success: {time(source.last_success_at)}</p></div>)}</div> : <p className="mt-4 text-sm text-emerald-700">All active news sources report no unresolved fetch error.</p>}</div><div className="rounded-xl border border-slate-200 bg-white p-5"><h2 className="text-lg font-semibold">Delivery recovery</h2>{deliveries.length ? <div className="mt-4 space-y-3">{deliveries.map((delivery) => <div key={delivery.id} className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm"><p className="font-semibold uppercase text-amber-900">{delivery.channel} · {delivery.status}</p><p className="mt-1 text-amber-800">{delivery.error_message ?? `Claimed at ${time(delivery.claimed_at)}`}</p><p className="mt-1 text-xs text-amber-700">Attempts: {delivery.attempt_count}</p></div>)}</div> : <p className="mt-4 text-sm text-emerald-700">No claimed or uncertain notification delivery needs review.</p>}<Link href="/market-intelligence" className="mt-4 inline-flex text-sm font-semibold text-blue-700 hover:underline">Open delivery recovery controls</Link></div></section>
    </div></main>;
}

function Metric({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
    return <div className="rounded-xl border border-slate-200 bg-white p-5"><p className="text-sm text-slate-500">{label}</p><p className={`mt-2 text-2xl font-bold ${warn ? "text-amber-700" : "text-slate-950"}`}>{value}</p></div>;
}

function HealthRow({ name, cadence, run, expected, health, href }: { name: string; cadence: string; run: Run | null; expected: string; health: Health; href: string }) {
    const Icon = health === "healthy" ? CheckCircle2 : health === "warning" ? Clock3 : AlertTriangle;
    const tone = health === "healthy" ? "text-emerald-700 bg-emerald-50" : health === "warning" ? "text-amber-700 bg-amber-50" : "text-red-700 bg-red-50";
    return <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between"><div className="flex gap-3"><span className={`mt-0.5 rounded-full p-2 ${tone}`}><Icon className="h-4 w-4" /></span><div><p className="font-semibold">{name}</p><p className="text-sm text-slate-500">{cadence} · expected {expected}</p><p className="mt-1 text-xs text-slate-400">Last publication: {time(run?.as_of)} · contract {run?.contract_version ?? "unavailable"}</p></div></div><div className="flex items-center gap-3 sm:text-right"><span className={`rounded-full px-3 py-1 text-xs font-semibold uppercase ${tone}`}>{health}</span><Link href={href} className="text-sm font-semibold text-blue-700 hover:underline">Review</Link></div></div>;
}
