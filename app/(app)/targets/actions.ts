"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function readText(formData: FormData, key: string): string {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
}

function readNumber(formData: FormData, key: string, fallbackValue: number) {
    const rawValue = readText(formData, key).replace(/,/g, "");

    if (!rawValue) {
        return fallbackValue;
    }

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

export async function updateTargets(formData: FormData) {
    const { supabase, userId } = await getSessionContext();

    const categoryIds = formData
        .getAll("category_id")
        .map((value) => String(value))
        .filter(Boolean);

    if (categoryIds.length === 0) {
        throw new Error("No categories found.");
    }

    const { data: categories, error: categoriesError } = await supabase
        .from("asset_categories")
        .select("id")
        .eq("user_id", userId)
        .in("id", categoryIds);

    if (categoriesError) {
        throw new Error(categoriesError.message);
    }

    const validCategoryIds = new Set((categories ?? []).map((category) => category.id));

    if (validCategoryIds.size !== categoryIds.length) {
        throw new Error("One or more categories are invalid.");
    }

    const targetRows = categoryIds.map((categoryId) => {
        const targetPercentage = readNumber(
            formData,
            `target_percentage_${categoryId}`,
            0
        );

        if (targetPercentage < 0) {
            throw new Error("Target percentage cannot be negative.");
        }

        if (targetPercentage > 100) {
            throw new Error("Target percentage cannot be above 100.");
        }

        return {
            user_id: userId,
            category_id: categoryId,
            target_percentage: targetPercentage,
        };
    });

    const totalTargetPercentage = targetRows.reduce(
        (sum, row) => sum + row.target_percentage,
        0
    );

    const roundedTotal = Math.round(totalTargetPercentage * 100) / 100;

    if (Math.abs(roundedTotal - 100) > 0.01) {
        throw new Error(
            `Target allocation total must be 100%. Current total is ${roundedTotal.toFixed(
                2
            )}%.`
        );
    }

    const { error } = await supabase.rpc("replace_targets", {
        p_rows: targetRows,
    });

    if (error) {
        throw new Error(error.message);
    }

    revalidatePath("/targets");
    revalidatePath("/dashboard");
    revalidatePath("/sip-plan");
    redirect("/targets");
}

export async function resetTargetsToDefault() {
    const { supabase, userId } = await getSessionContext();

    const { data: categories, error: categoriesError } = await supabase
        .from("asset_categories")
        .select("id")
        .eq("user_id", userId);

    if (categoriesError) {
        throw new Error(categoriesError.message);
    }

    if (!categories?.length) throw new Error("Add at least one category first.");

    const equalShare = Math.floor((10000 / categories.length)) / 100;
    const targetRows = categories.map((category, index) => ({
        user_id: userId,
        category_id: category.id,
        target_percentage:
            index === categories.length - 1
                ? Number((100 - equalShare * (categories.length - 1)).toFixed(2))
                : equalShare,
    }));

    const totalTargetPercentage = targetRows.reduce(
        (sum, row) => sum + row.target_percentage,
        0
    );

    if (Math.abs(totalTargetPercentage - 100) > 0.01) throw new Error("Could not calculate an equal allocation.");

    const { error } = await supabase.rpc("replace_targets", { p_rows: targetRows });

    if (error) {
        throw new Error(error.message);
    }

    revalidatePath("/targets");
    revalidatePath("/dashboard");
    revalidatePath("/sip-plan");
    redirect("/targets");
}
