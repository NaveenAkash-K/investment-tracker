import Link from "next/link";
import { redirect } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { StatusBanner } from "@/components/status-banner";
import { FormSubmitButton } from "@/components/form-submit-button";
import { reviewNewsEvent, saveNewsSettings } from "./actions";

type View = "actionable" | "portfolio" | "all";
type SearchParams = Promise<{ success?: string; error?: string; view?: string }>;
type EventRow = {
    id: string; event_type: string; headline: string; summary: string; event_status: string;
    posture: string; first_reported_at: string; last_updated_at: string;
    credibility_score: number | string; impact_score: number | string; urgency_score: number | string;
    market_confirmation_score: number | string; portfolio_relevance_score: number | string;
    time_horizon: string; countries: unknown; sectors: unknown; themes: unknown;
    source_count: number; article_count: number; primary_source_available: boolean;
    ai_enriched: boolean; ai_model: string | null; assessment_version: string;
    automatic_outcome_label: string; manual_outcome_label: string; manual_review_notes: string | null;
};
type Impact = { event_id: string; market_key: string; direction: number | string; magnitude: number | string; confidence: number | string; reason: string; origin: string };
type PortfolioImpact = { event_id: string; category_name: string; portfolio_weight_percentage: number | string; direction: number | string; relevance_score: number | string; confidence: number | string; reason: string };
type Reaction = { event_id: string; market_key: string; return_percentage: number | string | null; reaction_z_score: number | string | null; confirmation_status: string; observed_at: string | null };
type Article = { id: string; source_id: string; title: string; url: string; published_at: string; raw_metadata: unknown };
type LinkRow = { event_id: string; article_id: string };

const NOISE_TYPES = new Set(["stock_tips", "promotional", "opinion", "irrelevant", "market_news"]);

function n(value: unknown) { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; }
function list(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function date(value: string | null) { return value ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(value)) : "N/A"; }
function signed(value: unknown) { const number = n(value); return `${number > 0 ? "+" : ""}${number.toFixed(1)}%`; }
function byEvent<T extends { event_id: string }>(rows: T[]) { const map = new Map<string, T[]>(); for (const row of rows) map.set(row.event_id, [...(map.get(row.event_id) ?? []), row]); return map; }
function articlePublisher(article: Article, fallback: string) { const metadata = article.raw_metadata && typeof article.raw_metadata === "object" ? article.raw_metadata as Record<string, unknown> : {}; return typeof metadata.publisher === "string" && metadata.publisher ? metadata.publisher : fallback; }
function normalized(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function repeatedSummary(event: EventRow) { const title = normalized(event.headline); const summary = normalized(event.summary); return !summary || title === summary || (title.length > 20 && summary.includes(title)); }

export default async function NewsEventsPage({ searchParams }: { searchParams: SearchParams }) {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) redirect("/auth/login");
    const params = await searchParams;
    const view: View = params.view === "portfolio" || params.view === "all" ? params.view : "actionable";
    const [settingsResult, runResult, eventsResult, sourcesResult] = await Promise.all([
        supabase.from("news_settings").select("*").eq("user_id", user.id).maybeSingle(),
        supabase.from("news_pipeline_runs").select("*").eq("user_id", user.id).order("as_of", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("market_events").select("id,event_type,headline,summary,event_status,posture,first_reported_at,last_updated_at,credibility_score,impact_score,urgency_score,market_confirmation_score,portfolio_relevance_score,time_horizon,countries,sectors,themes,source_count,article_count,primary_source_available,ai_enriched,ai_model,assessment_version,automatic_outcome_label,manual_outcome_label,manual_review_notes").eq("user_id", user.id).order("impact_score", { ascending: false }).order("last_updated_at", { ascending: false }).limit(100),
        supabase.from("news_sources").select("id,name,last_success_at,last_error,consecutive_failures").eq("user_id", user.id).order("name"),
    ]);
    const setupError = settingsResult.error || runResult.error || eventsResult.error || sourcesResult.error;
    if (setupError) return <main className="mx-auto max-w-5xl px-4 py-8"><PageHeader title="News & Events" description="Evidence-led market-impact tracking." /><StatusBanner error={params.error} success={params.success} /><div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900"><h2 className="font-semibold">News & Events is not ready</h2><p className="mt-2">{setupError.message}</p><p className="mt-2">Apply the News & Events migration, then run the news worker.</p></div></main>;

    const events = (eventsResult.data ?? []) as EventRow[];
    const ids = events.map((event) => event.id);
    const empty = { data: [], error: null };
    const [impactsResult, portfolioResult, reactionsResult, linksResult] = await Promise.all([
        ids.length ? supabase.from("market_event_impacts").select("event_id,market_key,direction,magnitude,confidence,reason,origin").eq("user_id", user.id).in("event_id", ids) : Promise.resolve(empty),
        ids.length ? supabase.from("portfolio_event_impacts").select("event_id,category_name,portfolio_weight_percentage,direction,relevance_score,confidence,reason").eq("user_id", user.id).in("event_id", ids) : Promise.resolve(empty),
        ids.length ? supabase.from("market_event_reactions").select("event_id,market_key,return_percentage,reaction_z_score,confirmation_status,observed_at").eq("user_id", user.id).in("event_id", ids) : Promise.resolve(empty),
        ids.length ? supabase.from("market_event_articles").select("event_id,article_id").eq("user_id", user.id).in("event_id", ids) : Promise.resolve(empty),
    ]);
    const links = (linksResult.data ?? []) as LinkRow[];
    const articleIds = [...new Set(links.map((row) => row.article_id))];
    const articlesResult = articleIds.length ? await supabase.from("news_articles").select("id,source_id,title,url,published_at,raw_metadata").eq("user_id", user.id).in("id", articleIds) : empty;
    const secondaryError = impactsResult.error || portfolioResult.error || reactionsResult.error || linksResult.error || articlesResult.error;
    const impacts = byEvent((impactsResult.data ?? []) as Impact[]);
    const portfolio = byEvent((portfolioResult.data ?? []) as PortfolioImpact[]);
    const reactions = byEvent((reactionsResult.data ?? []) as Reaction[]);
    const eventLinks = byEvent(links);
    const articles = new Map(((articlesResult.data ?? []) as Article[]).map((row) => [row.id, row]));
    const sources = new Map((sourcesResult.data ?? []).map((row) => [row.id, row.name]));
    const claimedArticles = new Set<string>();
    const canonicalEvents = events.filter((event) => {
        const eventArticleIds = (eventLinks.get(event.id) ?? []).map((row) => row.article_id);
        if (eventArticleIds.length && eventArticleIds.every((articleId) => claimedArticles.has(articleId))) return false;
        eventArticleIds.forEach((articleId) => claimedArticles.add(articleId));
        return true;
    });
    const run = runResult.data;
    const settings = settingsResult.data ?? { is_enabled: true, ai_enrichment_enabled: true, immediate_alert_threshold: 80, portfolio_relevance_threshold: 25, digest_hour_ist: 18, send_daily_digest: true };
    const isActionable = (event: EventRow) => (impacts.get(event.id)?.length ?? 0) > 0 || (event.event_type === "market_context" && n(event.portfolio_relevance_score) >= n(settings.portfolio_relevance_threshold));
    const visibleEvents = canonicalEvents.filter((event) => view === "all" || (view === "portfolio" ? n(event.portfolio_relevance_score) > 0 : isActionable(event)));
    const scoredReviews = canonicalEvents.filter((event) => ["correct", "partial", "false_positive"].includes(event.manual_outcome_label));
    const unverifiable = canonicalEvents.filter((event) => event.manual_outcome_label === "unverifiable").length;
    const falsePositives = scoredReviews.filter((event) => event.manual_outcome_label === "false_positive").length;
    const high = canonicalEvents.filter((event) => isActionable(event) && n(event.impact_score) >= n(settings.immediate_alert_threshold)).length;
    const relevant = canonicalEvents.filter((event) => n(event.portfolio_relevance_score) >= n(settings.portfolio_relevance_threshold)).length;

    return <main className="mx-auto max-w-7xl px-4 py-8">
        <PageHeader title="News & Events" description="Global events grouped into evidence clusters, separated into exposure relevance and directional predictions. Advisory only." />
        <StatusBanner success={params.success} error={params.error || secondaryError?.message} />
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <Summary label="Latest run" value={run ? String(run.status).toUpperCase() : "WAITING"} helper={run ? `${date(run.as_of)} · ${run.model_version}` : "Run the news worker"} />
            <Summary label="Event clusters" value={String(canonicalEvents.length)} helper={`${run?.fetched_count ?? 0} normalized articles in latest run`} />
            <Summary label="High impact" value={String(high)} helper={`Actionable events above ${n(settings.immediate_alert_threshold).toFixed(0)}`} tone={high ? "warn" : undefined} />
            <Summary label="Portfolio relevant" value={String(relevant)} helper={`Exposure relevance above ${n(settings.portfolio_relevance_threshold).toFixed(0)}`} />
            <Summary label="Reviewed precision" value={scoredReviews.length ? `${((scoredReviews.length - falsePositives) / scoredReviews.length * 100).toFixed(0)}%` : "N/A"} helper={scoredReviews.length ? `${falsePositives} false positives / ${scoredReviews.length} scored${unverifiable ? ` · ${unverifiable} unverifiable excluded` : ""}` : "Measured separately by rules version"} />
        </section>

        {run?.data_issues?.length ? <section className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5"><h2 className="font-semibold text-amber-950">Source health warnings</h2><div className="mt-3 space-y-2 text-sm text-amber-900">{run.data_issues.map((issue: { source?: string; message?: string }, index: number) => <p key={index}><b>{issue.source ?? "Source"}:</b> {issue.message}</p>)}</div></section> : null}

        <nav aria-label="News views" className="mt-6 flex flex-wrap gap-2">
            <ViewLink href="/news-events" active={view === "actionable"}>Actionable & meaningful</ViewLink>
            <ViewLink href="/news-events?view=portfolio" active={view === "portfolio"}>My portfolio</ViewLink>
            <ViewLink href="/news-events?view=all" active={view === "all"}>All headlines</ViewLink>
        </nav>

        <section className="mt-4 grid gap-6 xl:grid-cols-[1fr_320px]">
            <div className="space-y-5">
                {visibleEvents.length ? visibleEvents.map((event) => {
                    const eventImpacts = impacts.get(event.id) ?? [];
                    const eventPortfolio = portfolio.get(event.id) ?? [];
                    const eventReactions = reactions.get(event.id) ?? [];
                    const evidence = (eventLinks.get(event.id) ?? []).map((row) => articles.get(row.article_id)).filter((row): row is Article => Boolean(row));
                    const exposureOnly = !eventImpacts.length && eventPortfolio.length > 0;
                    const noise = NOISE_TYPES.has(event.event_type);
                    return <article key={event.id} className={`rounded-xl border bg-white p-5 shadow-sm ${noise ? "border-slate-200 opacity-90" : "border-slate-200"}`}>
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                            <Badge value={event.event_type.replaceAll("_", " ")} />
                            <Badge value={event.posture} tone={event.posture === "RISK_OFF" ? "danger" : event.posture === "RISK_ON" ? "good" : "neutral"} />
                            <Badge value={`${n(event.impact_score).toFixed(0)} impact`} tone={n(event.impact_score) >= 80 ? "danger" : "neutral"} />
                            {exposureOnly ? <Badge value="exposure only" tone="info" /> : null}
                            <span className="text-slate-500">First {date(event.first_reported_at)}</span>
                        </div>
                        <h2 className="mt-3 text-xl font-semibold tracking-tight text-slate-950">{event.headline}</h2>
                        {!repeatedSummary(event) ? <p className="mt-2 text-sm leading-6 text-slate-600">{event.summary}</p> : null}
                        <p className="mt-2 text-xs text-slate-500">Updated {date(event.last_updated_at)} · {event.source_count} publisher{event.source_count === 1 ? "" : "s"} · {event.article_count} article{event.article_count === 1 ? "" : "s"}</p>
                        <div className="mt-4 grid gap-3 sm:grid-cols-4">
                            <Metric label="Credibility" value={event.credibility_score} />
                            <Metric label="Urgency" value={event.urgency_score} />
                            <Metric label="Portfolio" value={event.portfolio_relevance_score} />
                            <Metric label="Market reaction" value={eventImpacts.length ? event.market_confirmation_score : null} empty="Not evaluated" />
                        </div>
                        {eventPortfolio.length ? <div className="mt-4"><h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Your portfolio</h3><div className="mt-2 grid gap-2 sm:grid-cols-2">{eventPortfolio.map((row) => <div key={row.category_name} className="rounded-lg bg-blue-50 p-3 text-sm"><div className="flex justify-between gap-3"><b>{row.category_name}</b><Direction value={row.direction} exposureOnly={row.reason.startsWith("Exposure relevance only")} /></div><p className="mt-1 text-xs text-blue-800">Relevance {n(row.relevance_score).toFixed(0)}/100 · {n(row.portfolio_weight_percentage).toFixed(1)}% portfolio weight</p><p className="mt-1 text-xs text-blue-700">{row.reason}</p></div>)}</div></div> : null}
                        {eventImpacts.length ? <details className="mt-4 rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer text-sm font-medium">Expected market impact ({eventImpacts.length})</summary><div className="mt-3 space-y-2">{eventImpacts.map((row) => { const reaction = eventReactions.find((item) => item.market_key === row.market_key); return <div key={row.market_key} className="grid gap-1 rounded-lg bg-slate-50 p-3 text-sm sm:grid-cols-[100px_90px_1fr_auto]"><b>{row.market_key}</b><Direction value={row.direction} /><span className="text-slate-600">{row.reason}</span><span className="text-xs text-slate-500">{reaction ? `${reaction.confirmation_status}${reaction.return_percentage == null ? "" : ` · ${signed(reaction.return_percentage)}`}` : "Awaiting a completed market session"}</span></div>})}</div></details> : <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">No directional market prediction was made. This is {exposureOnly ? "portfolio-relevant context" : "an informational headline"}, so market confirmation is not applicable.</div>}
                        <div className="mt-4 flex flex-wrap gap-2">{[...list(event.countries), ...list(event.sectors), ...list(event.themes)].map((value) => <span key={value} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">{value}</span>)}</div>
                        <details className="mt-4 border-t border-slate-100 pt-4"><summary className="cursor-pointer text-sm font-medium text-slate-700">Evidence, scoring and review</summary><div className="mt-3 grid gap-5 lg:grid-cols-2"><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Evidence</p><div className="mt-2 space-y-2">{evidence.map((article) => <a key={article.id} href={article.url} target="_blank" rel="noreferrer" className="flex gap-2 text-sm text-blue-700 hover:underline"><ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{articlePublisher(article, sources.get(article.source_id) ?? "Source")}: {article.title}</span></a>)}</div><p className="mt-3 text-xs leading-5 text-slate-500">{event.ai_enriched ? `AI-enriched with ${event.ai_model}; deterministic conflicts retain rule precedence.` : "Deterministic assessment only."} Version {event.assessment_version}. Automatic outcome: {eventImpacts.length ? event.automatic_outcome_label : "not evaluated"}.</p></div><form action={reviewNewsEvent} className="space-y-3"><input type="hidden" name="event_id" value={event.id} /><label className="block text-sm font-medium">Was this classification useful{eventImpacts.length ? " and directionally reasonable" : ""}?<select name="label" defaultValue={event.manual_outcome_label === "unreviewed" ? "correct" : event.manual_outcome_label} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2"><option value="correct">Correct / useful</option><option value="partial">Partially correct</option><option value="false_positive">False positive</option><option value="unverifiable">Unverifiable</option></select></label><label className="block text-sm font-medium">Review note<textarea name="notes" defaultValue={event.manual_review_notes ?? ""} rows={3} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" placeholder="What happened, or why was this noise?" /></label><FormSubmitButton pendingText="Saving review...">Save review</FormSubmitButton></form></div></details>
                    </article>;
                }) : <div className="rounded-xl border border-blue-200 bg-blue-50 p-6 text-blue-900"><h2 className="font-semibold">No events in this view</h2><p className="mt-2 text-sm">This is a valid result. Try “All headlines” for stored informational items, or wait for the next worker run.</p></div>}
            </div>
            <aside className="space-y-5">
                <section className="rounded-xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Alert controls</h2><p className="mt-1 text-xs leading-5 text-slate-500">Immediate alerts require a directional event plus both impact and personal relevance thresholds.</p><form action={saveNewsSettings} className="mt-4 space-y-4"><label className="flex gap-2 text-sm font-medium"><input name="is_enabled" type="checkbox" defaultChecked={settings.is_enabled} /> Enable collection</label><label className="block text-sm font-medium">High-impact threshold<input name="immediate_alert_threshold" type="number" min="0" max="100" step="1" defaultValue={settings.immediate_alert_threshold} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" /></label><label className="block text-sm font-medium">Portfolio relevance threshold<input name="portfolio_relevance_threshold" type="number" min="0" max="100" step="1" defaultValue={settings.portfolio_relevance_threshold} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" /></label><label className="block text-sm font-medium">Daily digest hour (IST)<input name="digest_hour_ist" type="number" min="0" max="23" step="1" defaultValue={settings.digest_hour_ist} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" /></label><label className="flex gap-2 text-sm"><input name="send_daily_digest" type="checkbox" defaultChecked={settings.send_daily_digest} /> Send daily digest</label><label className="flex gap-2 text-sm"><input name="ai_enrichment_enabled" type="checkbox" defaultChecked={settings.ai_enrichment_enabled} /> Use optional AI enrichment</label><FormSubmitButton pendingText="Saving...">Save controls</FormSubmitButton></form></section>
                <section className="rounded-xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Source adapters</h2><div className="mt-3 space-y-3">{(sourcesResult.data ?? []).map((source) => <div key={source.id} className="text-sm"><div className="flex justify-between gap-3"><b>{source.name}</b><span className={source.last_error ? "text-amber-700" : "text-emerald-700"}>{source.last_error ? "Warning" : "Healthy"}</span></div><p className="mt-1 text-xs text-slate-500">Last success {date(source.last_success_at)}{source.consecutive_failures ? ` · ${source.consecutive_failures} failure(s)` : ""}</p></div>)}</div><p className="mt-4 text-xs leading-5 text-slate-500">Event credibility is calculated from the underlying publisher stored with each article, not from this adapter name.</p></section>
                <section className="rounded-xl border border-blue-200 bg-blue-50 p-5 text-sm text-blue-950"><h2 className="font-semibold">Guardrail</h2><p className="mt-2 leading-6">Exposure relevance means the subject concerns something you own. It is not automatically a positive or negative forecast. News cannot alter Market Intelligence, SIPs, Swing candidates, holdings, or trades.</p></section>
            </aside>
        </section>
    </main>;
}

function ViewLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) { return <Link href={href} aria-current={active ? "page" : undefined} className={`rounded-lg px-4 py-2 text-sm font-medium ${active ? "bg-slate-950 text-white" : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}>{children}</Link>; }
function Summary({ label, value, helper, tone }: { label: string; value: string; helper: string; tone?: "warn" }) { return <div className="rounded-xl border border-slate-200 bg-white p-5"><p className="text-sm text-slate-500">{label}</p><p className={`mt-2 text-2xl font-bold ${tone === "warn" ? "text-amber-700" : "text-slate-950"}`}>{value}</p><p className="mt-1 text-xs text-slate-500">{helper}</p></div>; }
function Metric({ label, value, empty = "N/A" }: { label: string; value: unknown | null; empty?: string }) { return <div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 font-semibold">{value === null ? empty : `${n(value).toFixed(0)}/100`}</p></div>; }
function Badge({ value, tone = "neutral" }: { value: string; tone?: "neutral" | "good" | "danger" | "info" }) { const color = tone === "good" ? "bg-emerald-50 text-emerald-700" : tone === "danger" ? "bg-red-50 text-red-700" : tone === "info" ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-600"; return <span className={`rounded-full px-2.5 py-1 font-medium uppercase ${color}`}>{value}</span>; }
function Direction({ value, exposureOnly = false }: { value: unknown; exposureOnly?: boolean }) { if (exposureOnly) return <span className="font-semibold text-blue-700">Relevant</span>; const number = n(value); return <span className={`font-semibold ${number > .05 ? "text-emerald-700" : number < -.05 ? "text-red-700" : "text-slate-500"}`}>{number > .05 ? "Positive" : number < -.05 ? "Negative" : "Neutral"}</span>; }
