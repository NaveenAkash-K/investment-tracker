import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getIndiaDate } from "@/lib/performance";

const TABLES = [
    "profiles", "asset_categories", "portfolio_targets", "holdings", "sip_plans",
    "investment_notes", "portfolio_snapshots", "snapshot_categories", "snapshot_sips",
    "monthly_category_performance",
    "market_signal_runs", "market_signal_scores", "sip_signal_recommendations",
    "global_signal_recommendations", "market_signal_alerts",
    "category_signal_mappings", "sip_signal_mappings",
    "swing_lab_settings", "swing_scan_runs", "swing_candidates",
    "swing_trades", "swing_trade_events",
    "news_settings", "news_sources", "news_pipeline_runs", "news_articles",
    "market_events", "market_event_articles", "market_event_impacts",
    "market_event_reactions", "portfolio_event_impacts",
    "news_event_evaluations", "market_event_alerts",
] as const;

const PAGE_SIZE = 1000;

async function fetchAllRows(
    supabase: Awaited<ReturnType<typeof createClient>>,
    table: (typeof TABLES)[number],
    userId: string
) {
    const rows: Record<string, unknown>[] = [];
    let from = 0;

    while (true) {
        const { data, error } = await supabase
            .from(table)
            .select("*")
            .eq("user_id", userId)
            .range(from, from + PAGE_SIZE - 1);

        if (error) return { data: rows, error };

        const page = (data ?? []) as Record<string, unknown>[];
        rows.push(...page);
        if (page.length < PAGE_SIZE) return { data: rows, error: null };
        from += PAGE_SIZE;
    }
}

export async function GET() {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const results = await Promise.all(TABLES.map(async (table) => ({
        table,
        ...await fetchAllRows(supabase, table, user.id),
    })));
    const failed = results.find((result) => result.error);
    if (failed?.error) return NextResponse.json({ error: failed.error.message, table: failed.table }, { status: 500 });

    const data = Object.fromEntries(results.map((result) => [result.table, result.data]));
    const body = JSON.stringify({
        format: "investment-tracker-backup",
        version: 2,
        exported_at: new Date().toISOString(),
        data,
    }, null, 2);

    return new NextResponse(body, { headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="investment-tracker-full-${getIndiaDate()}.json"`,
    }});
}
