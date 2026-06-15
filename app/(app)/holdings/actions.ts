"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function readText(formData: FormData, key: string): string {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
}

function readNumber(
    formData: FormData,
    key: string,
    fallbackValue: number
): number {
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

function today(): string {
    return new Date().toISOString().slice(0, 10);
}

function normalizeCurrency(value: string): string {
    const currency = value.trim().toUpperCase() || "INR";

    if (!["INR", "USD"].includes(currency)) {
        throw new Error("Currency must be INR or USD.");
    }

    return currency;
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
        throw new Error("Invalid asset category.");
    }
}

async function assertHoldingBelongsToUser(
    supabase: Awaited<ReturnType<typeof createClient>>,
    userId: string,
    holdingId: string
) {
    const { data, error } = await supabase
        .from("holdings")
        .select("id")
        .eq("id", holdingId)
        .eq("user_id", userId)
        .maybeSingle();

    if (error || !data) {
        throw new Error("Invalid holding.");
    }
}

function validateHoldingInput({
                                  name,
                                  categoryId,
                                  currentValue,
                                  exchangeRateToInr,
                              }: {
    name: string;
    categoryId: string;
    currentValue: number;
    exchangeRateToInr: number;
}) {
    if (!name) {
        throw new Error("Holding name is required.");
    }

    if (!categoryId) {
        throw new Error("Category is required.");
    }

    if (currentValue < 0) {
        throw new Error("Current value cannot be negative.");
    }

    if (exchangeRateToInr <= 0) {
        throw new Error("Exchange rate must be greater than zero.");
    }
}

export async function addHolding(formData: FormData) {
    const { supabase, userId } = await getSessionContext();

    const name = readText(formData, "name");
    const categoryId = readText(formData, "category_id");
    const assetType = readText(formData, "asset_type") || "Other";
    const currency = normalizeCurrency(readText(formData, "currency"));
    const currentValue = readNumber(formData, "current_value", 0);
    const exchangeRateToInr = readNumber(formData, "exchange_rate_to_inr", 1);
    const notes = readText(formData, "notes");

    validateHoldingInput({
        name,
        categoryId,
        currentValue,
        exchangeRateToInr,
    });

    await assertCategoryBelongsToUser(supabase, userId, categoryId);

    const { error } = await supabase.from("holdings").insert({
        user_id: userId,
        category_id: categoryId,
        name,
        asset_type: assetType,
        currency,
        current_value: currentValue,
        exchange_rate_to_inr: exchangeRateToInr,
        notes: notes || null,
        is_active: true,
        last_updated_at: today(),
    });

    if (error) {
        throw new Error(error.message);
    }

    revalidatePath("/holdings");
    revalidatePath("/dashboard");
    redirect("/holdings");
}

export async function updateHolding(formData: FormData) {
    const { supabase, userId } = await getSessionContext();

    const holdingId = readText(formData, "holding_id");
    const name = readText(formData, "name");
    const categoryId = readText(formData, "category_id");
    const assetType = readText(formData, "asset_type") || "Other";
    const currency = normalizeCurrency(readText(formData, "currency"));
    const currentValue = readNumber(formData, "current_value", 0);
    const exchangeRateToInr = readNumber(formData, "exchange_rate_to_inr", 1);
    const notes = readText(formData, "notes");

    if (!holdingId) {
        throw new Error("Holding ID is required.");
    }

    validateHoldingInput({
        name,
        categoryId,
        currentValue,
        exchangeRateToInr,
    });

    await assertHoldingBelongsToUser(supabase, userId, holdingId);
    await assertCategoryBelongsToUser(supabase, userId, categoryId);

    const { error } = await supabase
        .from("holdings")
        .update({
            category_id: categoryId,
            name,
            asset_type: assetType,
            currency,
            current_value: currentValue,
            exchange_rate_to_inr: exchangeRateToInr,
            notes: notes || null,
            last_updated_at: today(),
        })
        .eq("id", holdingId)
        .eq("user_id", userId);

    if (error) {
        throw new Error(error.message);
    }

    revalidatePath("/holdings");
    revalidatePath("/dashboard");
    redirect("/holdings");
}

export async function bulkUpdateHoldingValues(formData: FormData) {
    const { supabase, userId } = await getSessionContext();

    const holdingIds = formData
        .getAll("holding_id")
        .map((value) => String(value))
        .filter(Boolean);

    for (const holdingId of holdingIds) {
        const currentValue = readNumber(
            formData,
            `current_value_${holdingId}`,
            0
        );

        const exchangeRateToInr = readNumber(
            formData,
            `exchange_rate_to_inr_${holdingId}`,
            1
        );

        if (currentValue < 0) {
            throw new Error("Current value cannot be negative.");
        }

        if (exchangeRateToInr <= 0) {
            throw new Error("Exchange rate must be greater than zero.");
        }

        const { error } = await supabase
            .from("holdings")
            .update({
                current_value: currentValue,
                exchange_rate_to_inr: exchangeRateToInr,
                last_updated_at: today(),
            })
            .eq("id", holdingId)
            .eq("user_id", userId);

        if (error) {
            throw new Error(error.message);
        }
    }

    revalidatePath("/holdings");
    revalidatePath("/dashboard");
    redirect("/holdings");
}

export async function archiveHolding(formData: FormData) {
    const { supabase, userId } = await getSessionContext();

    const holdingId = readText(formData, "holding_id");

    if (!holdingId) {
        throw new Error("Holding ID is required.");
    }

    await assertHoldingBelongsToUser(supabase, userId, holdingId);

    const { error } = await supabase
        .from("holdings")
        .update({
            is_active: false,
            last_updated_at: today(),
        })
        .eq("id", holdingId)
        .eq("user_id", userId);

    if (error) {
        throw new Error(error.message);
    }

    revalidatePath("/holdings");
    revalidatePath("/dashboard");
    redirect("/holdings");
}