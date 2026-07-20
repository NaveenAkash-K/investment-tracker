import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { toCsv } from "@/lib/csv";

function downloadResponse(filename: string, csv: string) {
    return new NextResponse(csv, {
        status: 200,
        headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`,
        },
    });
}

function toNumber(value: unknown): number {
    const numberValue = Number(value ?? 0);
    return Number.isFinite(numberValue) ? numberValue : 0;
}

type HoldingExport = { name: string; asset_type: string | null; currency: string | null; current_value: unknown; exchange_rate_to_inr: unknown; current_value_inr: unknown; notes: string | null; is_active: boolean | null; last_updated_at: string | null; asset_categories: { name: string | null } | null };
type SipExport = { name: string; monthly_amount: unknown; sip_day: number | null; notes: string | null; is_active: boolean | null; asset_categories: { name: string | null } | null };
type TargetExport = { target_percentage: unknown; asset_categories: { name: string | null; sort_order: number | null } | null };
type SnapshotCategoryExport = { snapshot_id: string; category_name: string; amount_inr: unknown; current_percentage: unknown; target_percentage: unknown; difference_percentage: unknown };
type SnapshotSipExport = { snapshot_id: string; category_name: string; name: string; monthly_amount: unknown };

export async function GET(
    _request: Request,
    context: { params: Promise<{ kind: string }> }
) {
    const { kind } = await context.params;

    const supabase = await createClient();

    const {
        data: { user },
        error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (kind === "holdings") {
        const { data, error } = await supabase
            .from("holdings")
            .select(
                `
        name,
        asset_type,
        currency,
        current_value,
        exchange_rate_to_inr,
        current_value_inr,
        notes,
        is_active,
        last_updated_at,
        asset_categories(name)
      `
            )
            .eq("user_id", user.id)
            .order("name", { ascending: true });

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        const rows = ((data ?? []) as unknown as HoldingExport[]).map((holding) => ({
            name: holding.name,
            category: holding.asset_categories?.name ?? "",
            asset_type: holding.asset_type ?? "",
            currency: holding.currency ?? "INR",
            current_value: holding.current_value ?? 0,
            exchange_rate_to_inr: holding.exchange_rate_to_inr ?? 1,
            current_value_inr: holding.current_value_inr ?? 0,
            notes: holding.notes ?? "",
            is_active: holding.is_active ? "true" : "false",
            last_updated_at: holding.last_updated_at ?? "",
        }));

        return downloadResponse(
            "investment-tracker-holdings.csv",
            toCsv(
                [
                    "name",
                    "category",
                    "asset_type",
                    "currency",
                    "current_value",
                    "exchange_rate_to_inr",
                    "current_value_inr",
                    "notes",
                    "is_active",
                    "last_updated_at",
                ],
                rows
            )
        );
    }

    if (kind === "sip-plans") {
        const { data, error } = await supabase
            .from("sip_plans")
            .select(
                `
        name,
        monthly_amount,
        sip_day,
        notes,
        is_active,
        asset_categories(name)
      `
            )
            .eq("user_id", user.id)
            .order("name", { ascending: true });

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        const rows = ((data ?? []) as unknown as SipExport[]).map((sip) => ({
            name: sip.name,
            category: sip.asset_categories?.name ?? "",
            monthly_amount: sip.monthly_amount ?? 0,
            sip_day: sip.sip_day ?? "",
            notes: sip.notes ?? "",
            is_active: sip.is_active ? "true" : "false",
        }));

        return downloadResponse(
            "investment-tracker-sip-plans.csv",
            toCsv(
                ["name", "category", "monthly_amount", "sip_day", "notes", "is_active"],
                rows
            )
        );
    }

    if (kind === "targets") {
        const { data, error } = await supabase
            .from("portfolio_targets")
            .select(
                `
        target_percentage,
        asset_categories(name, sort_order)
      `
            )
            .eq("user_id", user.id);

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        const rows = ((data ?? []) as unknown as TargetExport[])
            .map((target) => ({
                category: target.asset_categories?.name ?? "",
                target_percentage: target.target_percentage ?? 0,
                sort_order: target.asset_categories?.sort_order ?? 999,
            }))
            .sort((a, b) => toNumber(a.sort_order) - toNumber(b.sort_order));

        return downloadResponse(
            "investment-tracker-targets.csv",
            toCsv(
                ["category", "target_percentage"],
                rows.map(({ category, target_percentage }) => ({
                    category,
                    target_percentage,
                }))
            )
        );
    }

    if (kind === "snapshots") {
        const [snapshotsResult, categoriesResult, sipsResult] = await Promise.all([
            supabase
                .from("portfolio_snapshots")
                .select(
                    "id, snapshot_month, total_value_inr, total_monthly_sip, note_title, note_content, created_at"
                )
                .eq("user_id", user.id)
                .order("snapshot_month", { ascending: false }),

            supabase
                .from("snapshot_categories")
                .select(
                    "snapshot_id, category_name, amount_inr, current_percentage, target_percentage, difference_percentage"
                )
                .eq("user_id", user.id),

            supabase
                .from("snapshot_sips")
                .select("snapshot_id, category_name, name, monthly_amount")
                .eq("user_id", user.id),
        ]);

        const queryError =
            snapshotsResult.error || categoriesResult.error || sipsResult.error;

        if (queryError) {
            return NextResponse.json({ error: queryError.message }, { status: 500 });
        }

        const categoriesBySnapshot = new Map<string, SnapshotCategoryExport[]>();
        const sipsBySnapshot = new Map<string, SnapshotSipExport[]>();

        for (const category of (categoriesResult.data ?? []) as SnapshotCategoryExport[]) {
            const existing = categoriesBySnapshot.get(category.snapshot_id) ?? [];
            existing.push(category);
            categoriesBySnapshot.set(category.snapshot_id, existing);
        }

        for (const sip of (sipsResult.data ?? []) as SnapshotSipExport[]) {
            const existing = sipsBySnapshot.get(sip.snapshot_id) ?? [];
            existing.push(sip);
            sipsBySnapshot.set(sip.snapshot_id, existing);
        }

        const rows = (snapshotsResult.data ?? []).flatMap((snapshot) => {
            const categories = categoriesBySnapshot.get(snapshot.id) ?? [];
            const sips = sipsBySnapshot.get(snapshot.id) ?? [];

            const categoryRows = categories.map((category) => ({
                snapshot_month: snapshot.snapshot_month,
                row_type: "category",
                total_value_inr: snapshot.total_value_inr,
                total_monthly_sip: snapshot.total_monthly_sip,
                category: category.category_name,
                name: "",
                amount: category.amount_inr,
                current_percentage: category.current_percentage,
                target_percentage: category.target_percentage,
                difference_percentage: category.difference_percentage,
                note_title: snapshot.note_title ?? "",
                note_content: snapshot.note_content ?? "",
                created_at: snapshot.created_at ?? "",
            }));

            const sipRows = sips.map((sip) => ({
                snapshot_month: snapshot.snapshot_month,
                row_type: "sip",
                total_value_inr: snapshot.total_value_inr,
                total_monthly_sip: snapshot.total_monthly_sip,
                category: sip.category_name,
                name: sip.name,
                amount: sip.monthly_amount,
                current_percentage: "",
                target_percentage: "",
                difference_percentage: "",
                note_title: snapshot.note_title ?? "",
                note_content: snapshot.note_content ?? "",
                created_at: snapshot.created_at ?? "",
            }));

            return [...categoryRows, ...sipRows];
        });

        return downloadResponse(
            "investment-tracker-snapshots.csv",
            toCsv(
                [
                    "snapshot_month",
                    "row_type",
                    "total_value_inr",
                    "total_monthly_sip",
                    "category",
                    "name",
                    "amount",
                    "current_percentage",
                    "target_percentage",
                    "difference_percentage",
                    "note_title",
                    "note_content",
                    "created_at",
                ],
                rows
            )
        );
    }

    return NextResponse.json({ error: "Invalid export type" }, { status: 400 });
}
