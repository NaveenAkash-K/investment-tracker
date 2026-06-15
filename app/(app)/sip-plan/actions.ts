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

function readNullableInteger(formData: FormData, key: string): number | null {
    const rawValue = readText(formData, key);

    if (!rawValue) {
        return null;
    }

    const value = Number(rawValue);

    if (!Number.isInteger(value)) {
        throw new Error(`${key} must be a valid whole number.`);
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

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

async function assertCategoryBelongsToUser(
    supabase: SupabaseServerClient,
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

async function assertSipBelongsToUser(
    supabase: SupabaseServerClient,
    userId: string,
    sipPlanId: string
) {
    const { data, error } = await supabase
        .from("sip_plans")
        .select("id")
        .eq("id", sipPlanId)
        .eq("user_id", userId)
        .maybeSingle();

    if (error || !data) {
        throw new Error("Invalid SIP plan.");
    }
}

function validateSipInput({
                              name,
                              categoryId,
                              monthlyAmount,
                              sipDay,
                          }: {
    name: string;
    categoryId: string;
    monthlyAmount: number;
    sipDay: number | null;
}) {
    if (!name) {
        throw new Error("SIP name is required.");
    }

    if (!categoryId) {
        throw new Error("Category is required.");
    }

    if (monthlyAmount < 0) {
        throw new Error("Monthly SIP amount cannot be negative.");
    }

    if (sipDay !== null && (sipDay < 1 || sipDay > 31)) {
        throw new Error("SIP day must be between 1 and 31.");
    }
}

export async function addSipPlan(formData: FormData) {
    const { supabase, userId } = await getSessionContext();

    const name = readText(formData, "name");
    const categoryId = readText(formData, "category_id");
    const monthlyAmount = readNumber(formData, "monthly_amount", 0);
    const sipDay = readNullableInteger(formData, "sip_day");
    const notes = readText(formData, "notes");

    validateSipInput({
        name,
        categoryId,
        monthlyAmount,
        sipDay,
    });

    await assertCategoryBelongsToUser(supabase, userId, categoryId);

    const { error } = await supabase.from("sip_plans").insert({
        user_id: userId,
        category_id: categoryId,
        name,
        monthly_amount: monthlyAmount,
        sip_day: sipDay,
        notes: notes || null,
        is_active: true,
    });

    if (error) {
        throw new Error(error.message);
    }

    revalidatePath("/sip-plan");
    revalidatePath("/dashboard");
    redirect("/sip-plan");
}

export async function updateSipPlan(formData: FormData) {
    const { supabase, userId } = await getSessionContext();

    const sipPlanId = readText(formData, "sip_plan_id");
    const name = readText(formData, "name");
    const categoryId = readText(formData, "category_id");
    const monthlyAmount = readNumber(formData, "monthly_amount", 0);
    const sipDay = readNullableInteger(formData, "sip_day");
    const notes = readText(formData, "notes");

    if (!sipPlanId) {
        throw new Error("SIP plan ID is required.");
    }

    validateSipInput({
        name,
        categoryId,
        monthlyAmount,
        sipDay,
    });

    await assertSipBelongsToUser(supabase, userId, sipPlanId);
    await assertCategoryBelongsToUser(supabase, userId, categoryId);

    const { error } = await supabase
        .from("sip_plans")
        .update({
            category_id: categoryId,
            name,
            monthly_amount: monthlyAmount,
            sip_day: sipDay,
            notes: notes || null,
        })
        .eq("id", sipPlanId)
        .eq("user_id", userId);

    if (error) {
        throw new Error(error.message);
    }

    revalidatePath("/sip-plan");
    revalidatePath("/dashboard");
    redirect("/sip-plan");
}

export async function bulkUpdateSipAmounts(formData: FormData) {
    const { supabase, userId } = await getSessionContext();

    const sipPlanIds = formData
        .getAll("sip_plan_id")
        .map((value) => String(value))
        .filter(Boolean);

    for (const sipPlanId of sipPlanIds) {
        const monthlyAmount = readNumber(
            formData,
            `monthly_amount_${sipPlanId}`,
            0
        );

        const sipDay = readNullableInteger(formData, `sip_day_${sipPlanId}`);

        if (monthlyAmount < 0) {
            throw new Error("Monthly SIP amount cannot be negative.");
        }

        if (sipDay !== null && (sipDay < 1 || sipDay > 31)) {
            throw new Error("SIP day must be between 1 and 31.");
        }

        const { error } = await supabase
            .from("sip_plans")
            .update({
                monthly_amount: monthlyAmount,
                sip_day: sipDay,
            })
            .eq("id", sipPlanId)
            .eq("user_id", userId);

        if (error) {
            throw new Error(error.message);
        }
    }

    revalidatePath("/sip-plan");
    revalidatePath("/dashboard");
    redirect("/sip-plan");
}

export async function archiveSipPlan(formData: FormData) {
    const { supabase, userId } = await getSessionContext();

    const sipPlanId = readText(formData, "sip_plan_id");

    if (!sipPlanId) {
        throw new Error("SIP plan ID is required.");
    }

    await assertSipBelongsToUser(supabase, userId, sipPlanId);

    const { error } = await supabase
        .from("sip_plans")
        .update({
            is_active: false,
        })
        .eq("id", sipPlanId)
        .eq("user_id", userId);

    if (error) {
        throw new Error(error.message);
    }

    revalidatePath("/sip-plan");
    revalidatePath("/dashboard");
    redirect("/sip-plan");
}