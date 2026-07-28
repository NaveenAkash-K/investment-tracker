"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function text(formData: FormData, key: string) {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
}

export async function saveSignalDecision(formData: FormData) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) redirect("/auth/login");

    const runId = text(formData, "run_id");
    const decisionStatus = text(formData, "decision_status");
    const decisionNote = text(formData, "decision_note");
    if (!runId || !["pending", "accepted", "modified", "skipped"].includes(decisionStatus)) {
        redirect("/market-intelligence?error=Invalid+decision");
    }

    const { error } = await supabase.rpc("save_market_signal_decision", {
        p_run_id: runId,
        p_decision_status: decisionStatus,
        p_decision_note: decisionNote || null,
    });

    if (error) redirect(`/market-intelligence?error=${encodeURIComponent(error.message)}`);
    revalidatePath("/market-intelligence");
    redirect("/market-intelligence?success=Decision+journal+saved");
}

export async function acknowledgeSignalAlert(formData: FormData) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) redirect("/auth/login");
    const alertId = text(formData, "alert_id");
    if (!alertId) redirect("/market-intelligence?error=Invalid+alert");

    const { error } = await supabase.rpc("acknowledge_market_signal_alert", {
        p_alert_id: alertId,
    });
    if (error) redirect(`/market-intelligence?error=${encodeURIComponent(error.message)}`);
    revalidatePath("/market-intelligence");
    redirect("/market-intelligence?success=Alert+acknowledged");
}
