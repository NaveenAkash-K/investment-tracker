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
    const { supabase } = await getSessionContext();

    const name = readText(formData, "name");
    const sortOrder = readNumber(formData, "sort_order", 99);
    const targetPercentage = readNumber(formData, "target_percentage", 0);
    const trackingCurrency = readText(formData, "tracking_currency") || "INR";

    validateCategoryName(name);

    if (targetPercentage < 0 || targetPercentage > 100) {
        throw new Error("Target percentage must be between 0 and 100.");
    }

    if (!["INR", "USD"].includes(trackingCurrency)) throw new Error("Tracking currency must be INR or USD.");

    const { error } = await supabase.rpc("add_asset_category", {
        p_name: name,
        p_sort_order: sortOrder,
        p_target_percentage: targetPercentage,
        p_tracking_currency: trackingCurrency,
    });

    if (error) throw new Error(error.message);

    revalidateEverything();
    redirect("/settings");
}

export async function updateCategory(formData: FormData) {
    const { supabase, userId } = await getSessionContext();

    const categoryId = readText(formData, "category_id");
    const name = readText(formData, "name");
    const sortOrder = readNumber(formData, "sort_order", 99);
    const trackingCurrency = readText(formData, "tracking_currency") || "INR";

    if (!categoryId) {
        throw new Error("Category ID is required.");
    }

    validateCategoryName(name);
    if (!["INR", "USD"].includes(trackingCurrency)) throw new Error("Tracking currency must be INR or USD.");
    await assertCategoryBelongsToUser(supabase, userId, categoryId);

    const { error } = await supabase.rpc("update_asset_category", {
        p_category_id: categoryId,
        p_name: name,
        p_sort_order: sortOrder,
        p_tracking_currency: trackingCurrency,
    });

    if (error) {
        throw new Error(error.message);
    }

    revalidateEverything();
    redirect("/settings");
}

export async function deleteCategory(formData: FormData) {
    const { supabase } = await getSessionContext();

    const categoryId = readText(formData, "category_id");

    if (!categoryId) {
        throw new Error("Category ID is required.");
    }

    const { error } = await supabase.rpc("delete_asset_category", { p_category_id: categoryId });

    if (error) {
        throw new Error(error.message);
    }

    revalidateEverything();
    redirect("/settings");
}
