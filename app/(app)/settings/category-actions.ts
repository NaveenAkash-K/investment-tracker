"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function readText(formData: FormData, key: string): string {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
}

function readNumber(formData: FormData, key: string, fallbackValue: number) {
    const rawValue = readText(formData, key);

    if (!rawValue) return fallbackValue;

    const value = Number(rawValue);

    if (!Number.isFinite(value)) {
        throw new Error(`${key} must be a valid number.`);
    }

    return value;
}

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

async function assertCategoryBelongsToUser(
    supabase: Awaited<ReturnType<typeof createClient>>,
    userId: string,
    categoryId: string
) {
    const { data, error } = await supabase
        .from("asset_categories")
        .select("id")
        .eq("id", categoryId)
        .eq("user_id", userId)
        .maybeSingle();

    if (error || !data) {
        throw new Error("Invalid category.");
    }
}

function validateCategoryName(name: string) {
    if (!name) {
        throw new Error("Category name is required.");
    }

    if (name.length > 80) {
        throw new Error("Category name should be 80 characters or less.");
    }
}

function revalidateEverything() {
    revalidatePath("/settings");
    revalidatePath("/dashboard");
    revalidatePath("/holdings");
    revalidatePath("/sip-plan");
    revalidatePath("/targets");
    revalidatePath("/snapshots");
    revalidatePath("/import-export");
}

export async function addCategory(formData: FormData) {
    const { supabase, userId } = await getSessionContext();

    const name = readText(formData, "name");
    const sortOrder = readNumber(formData, "sort_order", 99);
    const targetPercentage = readNumber(formData, "target_percentage", 0);

    validateCategoryName(name);

    if (targetPercentage < 0 || targetPercentage > 100) {
        throw new Error("Target percentage must be between 0 and 100.");
    }

    const { data: category, error: categoryError } = await supabase
        .from("asset_categories")
        .insert({
            user_id: userId,
            name,
            sort_order: sortOrder,
        })
        .select("id")
        .single();

    if (categoryError || !category) {
        throw new Error(categoryError?.message ?? "Failed to create category.");
    }

    const { error: targetError } = await supabase
        .from("portfolio_targets")
        .insert({
            user_id: userId,
            category_id: category.id,
            target_percentage: targetPercentage,
        });

    if (targetError) {
        throw new Error(targetError.message);
    }

    revalidateEverything();
    redirect("/settings");
}

export async function updateCategory(formData: FormData) {
    const { supabase, userId } = await getSessionContext();

    const categoryId = readText(formData, "category_id");
    const name = readText(formData, "name");
    const sortOrder = readNumber(formData, "sort_order", 99);

    if (!categoryId) {
        throw new Error("Category ID is required.");
    }

    validateCategoryName(name);
    await assertCategoryBelongsToUser(supabase, userId, categoryId);

    const { error } = await supabase
        .from("asset_categories")
        .update({
            name,
            sort_order: sortOrder,
        })
        .eq("id", categoryId)
        .eq("user_id", userId);

    if (error) {
        throw new Error(error.message);
    }

    revalidateEverything();
    redirect("/settings");
}

export async function deleteCategory(formData: FormData) {
    const { supabase, userId } = await getSessionContext();

    const categoryId = readText(formData, "category_id");

    if (!categoryId) {
        throw new Error("Category ID is required.");
    }

    await assertCategoryBelongsToUser(supabase, userId, categoryId);

    const [holdingsResult, sipPlansResult] = await Promise.all([
        supabase
            .from("holdings")
            .select("id")
            .eq("user_id", userId)
            .eq("category_id", categoryId)
            .eq("is_active", true)
            .limit(1),

        supabase
            .from("sip_plans")
            .select("id")
            .eq("user_id", userId)
            .eq("category_id", categoryId)
            .eq("is_active", true)
            .limit(1),
    ]);

    if (holdingsResult.error) {
        throw new Error(holdingsResult.error.message);
    }

    if (sipPlansResult.error) {
        throw new Error(sipPlansResult.error.message);
    }

    if ((holdingsResult.data ?? []).length > 0) {
        throw new Error(
            "Cannot delete this category because holdings are linked to it. Move or archive those holdings first."
        );
    }

    if ((sipPlansResult.data ?? []).length > 0) {
        throw new Error(
            "Cannot delete this category because SIP plans are linked to it. Move or archive those SIPs first."
        );
    }

    const { error: archivedHoldingsDeleteError } = await supabase
        .from("holdings")
        .delete()
        .eq("user_id", userId)
        .eq("category_id", categoryId)
        .eq("is_active", false);

    if (archivedHoldingsDeleteError) {
        throw new Error(archivedHoldingsDeleteError.message);
    }

    const { error: archivedSipDeleteError } = await supabase
        .from("sip_plans")
        .delete()
        .eq("user_id", userId)
        .eq("category_id", categoryId)
        .eq("is_active", false);

    if (archivedSipDeleteError) {
        throw new Error(archivedSipDeleteError.message);
    }

    const { error: targetDeleteError } = await supabase
        .from("portfolio_targets")
        .delete()
        .eq("category_id", categoryId)
        .eq("user_id", userId);

    if (targetDeleteError) {
        throw new Error(targetDeleteError.message);
    }

    const { error } = await supabase
        .from("asset_categories")
        .delete()
        .eq("id", categoryId)
        .eq("user_id", userId);

    if (error) {
        throw new Error(error.message);
    }

    revalidateEverything();
    redirect("/settings");
}