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
] as const;

export async function GET() {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const results = await Promise.all(TABLES.map(async (table) => {
        const { data, error } = await supabase.from(table).select("*").eq("user_id", user.id);
        return { table, data: data ?? [], error };
    }));
    const failed = results.find((result) => result.error);
    if (failed?.error) return NextResponse.json({ error: failed.error.message, table: failed.table }, { status: 500 });

    const data = Object.fromEntries(results.map((result) => [result.table, result.data]));
    const body = JSON.stringify({
        format: "investment-tracker-backup",
        version: 1,
        exported_at: new Date().toISOString(),
        data,
    }, null, 2);

    return new NextResponse(body, { headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="investment-tracker-full-${getIndiaDate()}.json"`,
    }});
}
