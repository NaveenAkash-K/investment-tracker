"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

async function getSessionContext() {
    const supabase = await createClient();

    const {
        data: { user },
        error,
    } = await supabase.auth.getUser();

    if (error || !user) {
        redirect("/auth/login");
    }

    return {
        supabase,
        userId: user.id,
    };
}

function toNumber(value: unknown): number {
    const numberValue = Number(value ?? 0);
    return Number.isFinite(numberValue) ? numberValue : 0;
}

function getCurrentMonthStart(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");

    return `${year}-${month}-01`;
}

function readText(formData: FormData, key: string): string {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
}

export async function createCurrentMonthSnapshot() {
    const { supabase, userId } = await getSessionContext();

    const snapshotMonth = getCurrentMonthStart();

    const [
        existingSnapshotResult,
        categoriesResult,
        holdingsResult,
        targetsResult,
        sipPlansResult,
        currentNoteResult,
    ] = await Promise.all([
        supabase
            .from("portfolio_snapshots")
            .select("id")
            .eq("user_id", userId)
            .eq("snapshot_month", snapshotMonth)
            .maybeSingle(),

        supabase
            .from("asset_categories")
            .select("id, name, sort_order")
            .eq("user_id", userId)
            .order("sort_order", { ascending: true }),

        supabase
            .from("holdings")
            .select("category_id, current_value_inr")
            .eq("user_id", userId)
            .eq("is_active", true),

        supabase
            .from("portfolio_targets")
            .select("category_id, target_percentage")
            .eq("user_id", userId),

        supabase
            .from("sip_plans")
            .select("id, category_id, name, monthly_amount")
            .eq("user_id", userId)
            .eq("is_active", true),

        supabase
            .from("investment_notes")
            .select("id, title, content")
            .eq("user_id", userId)
            .eq("is_current", true)
            .maybeSingle(),
    ]);

    if (existingSnapshotResult.error) {
        throw new Error(existingSnapshotResult.error.message);
    }

    if (existingSnapshotResult.data) {
        throw new Error("A snapshot already exists for this month.");
    }

    const queryError =
        categoriesResult.error ||
        holdingsResult.error ||
        targetsResult.error ||
        sipPlansResult.error ||
        currentNoteResult.error;

    if (queryError) {
        throw new Error(queryError.message);
    }

    const categories = categoriesResult.data ?? [];
    const holdings = holdingsResult.data ?? [];
    const targets = targetsResult.data ?? [];
    const sipPlans = sipPlansResult.data ?? [];
    const currentNote = currentNoteResult.data ?? null;

    const amountByCategoryId = new Map<string, number>();
    const targetByCategoryId = new Map<string, number>();

    for (const holding of holdings) {
        const currentAmount = amountByCategoryId.get(holding.category_id) ?? 0;
        amountByCategoryId.set(
            holding.category_id,
            currentAmount + toNumber(holding.current_value_inr)
        );
    }

    for (const target of targets) {
        targetByCategoryId.set(
            target.category_id,
            toNumber(target.target_percentage)
        );
    }

    const totalValueInr = holdings.reduce(
        (sum, holding) => sum + toNumber(holding.current_value_inr),
        0
    );

    const totalMonthlySip = sipPlans.reduce(
        (sum, sipPlan) => sum + toNumber(sipPlan.monthly_amount),
        0
    );

    const { data: snapshot, error: snapshotError } = await supabase
        .from("portfolio_snapshots")
        .insert({
            user_id: userId,
            snapshot_month: snapshotMonth,
            total_value_inr: totalValueInr,
            total_monthly_sip: totalMonthlySip,
            note_id: currentNote?.id ?? null,
            note_title: currentNote?.title ?? null,
            note_content: currentNote?.content ?? null,
        })
        .select("id")
        .single();

    if (snapshotError || !snapshot) {
        throw new Error(snapshotError?.message ?? "Failed to create snapshot.");
    }

    const snapshotCategoryRows = categories.map((category) => {
        const amountInr = amountByCategoryId.get(category.id) ?? 0;
        const targetPercentage = targetByCategoryId.get(category.id) ?? 0;

        const currentPercentage =
            totalValueInr > 0 ? (amountInr / totalValueInr) * 100 : 0;

        const differencePercentage = currentPercentage - targetPercentage;

        return {
            user_id: userId,
            snapshot_id: snapshot.id,
            category_id: category.id,
            category_name: category.name,
            amount_inr: amountInr,
            current_percentage: currentPercentage,
            target_percentage: targetPercentage,
            difference_percentage: differencePercentage,
        };
    });

    if (snapshotCategoryRows.length > 0) {
        const { error: categoryError } = await supabase
            .from("snapshot_categories")
            .insert(snapshotCategoryRows);

        if (categoryError) {
            throw new Error(categoryError.message);
        }
    }

    const categoryNameById = new Map(
        categories.map((category) => [category.id, category.name])
    );

    const snapshotSipRows = sipPlans.map((sipPlan) => ({
        user_id: userId,
        snapshot_id: snapshot.id,
        category_id: sipPlan.category_id,
        category_name: categoryNameById.get(sipPlan.category_id) ?? "Unknown",
        name: sipPlan.name,
        monthly_amount: toNumber(sipPlan.monthly_amount),
    }));

    if (snapshotSipRows.length > 0) {
        const { error: sipError } = await supabase
            .from("snapshot_sips")
            .insert(snapshotSipRows);

        if (sipError) {
            throw new Error(sipError.message);
        }
    }

    revalidatePath("/snapshots");
    revalidatePath("/dashboard");
    redirect("/snapshots");
}

export async function deleteSnapshot(formData: FormData) {
    const { supabase, userId } = await getSessionContext();

    const snapshotId = readText(formData, "snapshot_id");

    if (!snapshotId) {
        throw new Error("Snapshot ID is required.");
    }

    const { error } = await supabase
        .from("portfolio_snapshots")
        .delete()
        .eq("id", snapshotId)
        .eq("user_id", userId);

    if (error) {
        throw new Error(error.message);
    }

    revalidatePath("/snapshots");
    redirect("/snapshots");
}