"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function readId(formData: FormData, key: string) {
    const value = formData.get(key);
    if (typeof value !== "string" || !value) throw new Error("Record ID is required.");
    return value;
}

async function context() {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) redirect("/auth/login");
    return { supabase, userId: user.id };
}

function refresh() {
    revalidatePath("/archive");
    revalidatePath("/dashboard");
    revalidatePath("/holdings");
    revalidatePath("/sip-plan");
    revalidatePath("/settings");
}

async function changeRecord(
    table: "holdings" | "sip_plans",
    id: string,
    operation: "restore" | "delete"
) {
    const { supabase, userId } = await context();
    const query = operation === "restore"
        ? supabase.from(table).update({ is_active: true }).eq("id", id).eq("user_id", userId).eq("is_active", false)
        : supabase.from(table).delete().eq("id", id).eq("user_id", userId).eq("is_active", false);
    const { error } = await query;
    if (error) throw new Error(error.message);
    refresh();
    redirect("/archive");
}

export async function restoreHolding(formData: FormData) {
    await changeRecord("holdings", readId(formData, "holding_id"), "restore");
}

export async function permanentlyDeleteHolding(formData: FormData) {
    await changeRecord("holdings", readId(formData, "holding_id"), "delete");
}

export async function restoreSipPlan(formData: FormData) {
    await changeRecord("sip_plans", readId(formData, "sip_plan_id"), "restore");
}

export async function permanentlyDeleteSipPlan(formData: FormData) {
    await changeRecord("sip_plans", readId(formData, "sip_plan_id"), "delete");
}
