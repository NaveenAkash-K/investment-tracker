"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function text(formData: FormData, key: string) {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
}

function number(formData: FormData, key: string) {
    const value = Number(text(formData, key).replace(/,/g, ""));
    if (!Number.isFinite(value)) throw new Error(`${key} must be a valid number.`);
    return value;
}

function integer(formData: FormData, key: string) {
    const value = number(formData, key);
    if (!Number.isInteger(value)) throw new Error(`${key} must be a whole number.`);
    return value;
}

function required(formData: FormData, key: string) {
    const value = text(formData, key);
    if (!value) throw new Error(`${key} is required.`);
    return value;
}

function destination(type: "success" | "error", message: string) {
    return `/swing-lab?${type}=${encodeURIComponent(message)}`;
}

async function authenticatedClient() {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) redirect("/auth/login");
    return supabase;
}

async function execute(operation: () => Promise<void>, success: string) {
    try {
        await operation();
    } catch (error) {
        redirect(destination("error", error instanceof Error ? error.message : "Swing Lab action failed."));
    }
    revalidatePath("/swing-lab");
    redirect(destination("success", success));
}

export async function saveSwingSettings(formData: FormData) {
    await execute(async () => {
        const supabase = await authenticatedClient();
        const { error } = await supabase.rpc("save_swing_lab_settings", {
            p_trading_capital_inr: number(formData, "trading_capital_inr"),
            p_risk_per_trade_percentage: number(formData, "risk_per_trade_percentage"),
            p_max_open_positions: integer(formData, "max_open_positions"),
            p_max_sector_positions: integer(formData, "max_sector_positions"),
            p_minimum_setup_score: number(formData, "minimum_setup_score"),
            p_paper_mode: formData.get("paper_mode") === "on",
        });
        if (error) throw new Error(error.message);
    }, "Swing Lab risk settings saved.");
}

export async function confirmSwingEntry(formData: FormData) {
    await execute(async () => {
        const supabase = await authenticatedClient();
        const candidateId = required(formData, "candidate_id");
        const { data: candidate, error: candidateError } = await supabase
            .from("swing_candidates")
            .select("setup_type")
            .eq("id", candidateId)
            .single();
        if (candidateError) throw new Error(candidateError.message);
        const testOnly = String(candidate.setup_type ?? "").startsWith("TEST_");
        const { error } = await supabase.rpc("confirm_swing_entry", {
            p_candidate_id: candidateId,
            p_entry_date: required(formData, "entry_date"),
            p_entry_price: number(formData, "entry_price"),
            p_quantity: integer(formData, "quantity"),
            p_trade_mode: testOnly ? "paper" : required(formData, "trade_mode"),
            p_notes: text(formData, "notes") || null,
        });
        if (error) throw new Error(error.message);
    }, "Actual swing entry confirmed and tracking started.");
}

export async function skipSwingCandidate(formData: FormData) {
    await execute(async () => {
        const supabase = await authenticatedClient();
        const { error } = await supabase.rpc("skip_swing_candidate", {
            p_candidate_id: required(formData, "candidate_id"),
            p_reason: text(formData, "reason") || null,
        });
        if (error) throw new Error(error.message);
    }, "Candidate marked as skipped.");
}

export async function updateSwingStop(formData: FormData) {
    await execute(async () => {
        const supabase = await authenticatedClient();
        const { error } = await supabase.rpc("update_swing_trade_stop", {
            p_trade_id: required(formData, "trade_id"),
            p_new_stop: number(formData, "new_stop"),
            p_reason: text(formData, "reason") || null,
        });
        if (error) throw new Error(error.message);
    }, "Protective stop updated.");
}

export async function confirmSwingExit(formData: FormData) {
    await execute(async () => {
        const supabase = await authenticatedClient();
        const { error } = await supabase.rpc("confirm_swing_exit", {
            p_trade_id: required(formData, "trade_id"),
            p_exit_date: required(formData, "exit_date"),
            p_exit_price: number(formData, "exit_price"),
            p_fees_inr: number(formData, "fees_inr"),
            p_notes: text(formData, "notes") || null,
        });
        if (error) throw new Error(error.message);
    }, "Actual exit confirmed and trade journal updated.");
}
