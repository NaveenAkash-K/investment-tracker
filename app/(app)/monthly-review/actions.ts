"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getIndiaMonthStart } from "@/lib/performance";

function readText(formData: FormData, key: string) {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
}

function readNumber(formData: FormData, key: string, fallback = 0) {
    const raw = readText(formData, key).replace(/,/g, "");
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${key} must be a valid number.`);
    return value;
}

function messageUrl(type: "success" | "error", message: string) {
    return `/monthly-review?${type}=${encodeURIComponent(message)}`;
}

export async function saveMonthlyReview(formData: FormData) {
    const supabase = await createClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError || !user) redirect("/auth/login");

    try {
        const categoryIds = formData.getAll("category_id").map(String).filter(Boolean);
        if (categoryIds.length === 0) throw new Error("No categories are available to save.");

        const rows = categoryIds.map((categoryId) => {
            const contributionInr = readNumber(formData, `contribution_inr_${categoryId}`);
            const contributionNative = readNumber(formData, `contribution_native_${categoryId}`);
            const contributionFxRate = readNumber(formData, `contribution_fx_rate_${categoryId}`, 1);
            const closingNativeValue = readNumber(formData, `closing_native_value_${categoryId}`);
            const closingFxRate = readNumber(formData, `closing_fx_rate_${categoryId}`, 1);

            if (contributionInr < 0 || contributionNative < 0 || closingNativeValue < 0) {
                throw new Error("Monthly amounts cannot be negative.");
            }
            if (contributionFxRate <= 0 || closingFxRate <= 0) {
                throw new Error("Exchange rates must be greater than zero.");
            }

            return {
                category_id: categoryId,
                contribution_inr: contributionInr,
                contribution_native: contributionNative,
                contribution_fx_rate: contributionFxRate,
                closing_native_value: closingNativeValue,
                closing_fx_rate: closingFxRate,
            };
        });

        const { error } = await supabase.rpc("save_monthly_category_performance", {
            p_month: getIndiaMonthStart(),
            p_rows: rows,
        });

        if (error) throw new Error(error.message);
    } catch (error) {
        redirect(messageUrl("error", error instanceof Error ? error.message : "Monthly review could not be saved."));
    }

    revalidatePath("/monthly-review");
    revalidatePath("/dashboard");
    revalidatePath("/snapshots");
    redirect(messageUrl("success", "Monthly contribution and performance values were saved."));
}
