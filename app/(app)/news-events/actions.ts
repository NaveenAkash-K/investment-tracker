"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function text(formData: FormData, key: string) {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
}

function number(formData: FormData, key: string) {
    const value = Number(text(formData, key));
    if (!Number.isFinite(value)) throw new Error(`${key} must be a number.`);
    return value;
}

export async function saveNewsSettings(formData: FormData) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) redirect("/auth/login");
    const { error } = await supabase.rpc("save_news_settings", {
        p_is_enabled: formData.get("is_enabled") === "on",
        p_ai_enrichment_enabled: formData.get("ai_enrichment_enabled") === "on",
        p_immediate_alert_threshold: number(formData, "immediate_alert_threshold"),
        p_portfolio_relevance_threshold: number(formData, "portfolio_relevance_threshold"),
        p_digest_hour_ist: number(formData, "digest_hour_ist"),
        p_send_daily_digest: formData.get("send_daily_digest") === "on",
    });
    if (error) redirect(`/news-events?error=${encodeURIComponent(error.message)}`);
    revalidatePath("/news-events");
    redirect("/news-events?success=News+settings+saved");
}

export async function reviewNewsEvent(formData: FormData) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) redirect("/auth/login");
    const eventId = text(formData, "event_id");
    const label = text(formData, "label");
    if (!eventId || !["correct", "partial", "false_positive", "unverifiable"].includes(label)) {
        redirect("/news-events?error=Invalid+event+review");
    }
    const { error } = await supabase.rpc("review_news_event", {
        p_event_id: eventId,
        p_label: label,
        p_notes: text(formData, "notes") || null,
    });
    if (error) redirect(`/news-events?error=${encodeURIComponent(error.message)}`);
    revalidatePath("/news-events");
    redirect("/news-events?success=Event+review+saved");
}
