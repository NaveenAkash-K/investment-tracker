"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const MARKET_KEYS = new Set(["NIFTY50", "NIFTYMID", "NIFTYSMALL", "VOO", "QQQM", "VEA", "EWY", "EWT", "EWW", "EWZ", "BTC", "ETH", "GOLDSILVER", "DEBT"]);

function read(formData: FormData, key: string) {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
}

function parseMappings(raw: string) {
    const entries = raw.split(/[\n,]+/).map((part) => part.trim()).filter(Boolean);
    if (!entries.length) throw new Error("Add at least one mapping, for example NIFTY50:100%.");
    const seen = new Set<string>();
    const rows = entries.map((entry) => {
        const match = entry.match(/^([A-Za-z0-9_]+)\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)\s*(%)?$/);
        if (!match) throw new Error(`Invalid mapping '${entry}'. Use MARKET:50%.`);
        const marketKey = match[1].toUpperCase();
        if (!MARKET_KEYS.has(marketKey)) throw new Error(`Unknown market key: ${marketKey}.`);
        if (seen.has(marketKey)) throw new Error(`${marketKey} appears more than once.`);
        seen.add(marketKey);
        const supplied = Number(match[2]);
        const weight = match[3] || supplied > 1 ? supplied / 100 : supplied;
        if (!Number.isFinite(weight) || weight <= 0 || weight > 1) throw new Error(`Invalid weight for ${marketKey}.`);
        return { market_key: marketKey, exposure_weight: weight };
    });
    const total = rows.reduce((sum, row) => sum + row.exposure_weight, 0);
    if (Math.abs(total - 1) > 0.0001) throw new Error(`Mapping weights must total 100%. Current total is ${(total * 100).toFixed(2)}%.`);
    return rows;
}

function message(type: "success" | "error", value: string) {
    return `/market-intelligence/settings?${type}=${encodeURIComponent(value)}`;
}

export async function saveSipSignalMapping(formData: FormData) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) redirect("/auth/login");
    try {
        const sipPlanId = read(formData, "sip_plan_id");
        const rows = parseMappings(read(formData, "mappings"));
        const { error } = await supabase.rpc("replace_sip_signal_mappings", { p_sip_plan_id: sipPlanId, p_rows: rows });
        if (error) throw new Error(error.message);
    } catch (error) {
        redirect(message("error", error instanceof Error ? error.message : "Mapping could not be saved."));
    }
    revalidatePath("/market-intelligence/settings");
    redirect(message("success", "SIP signal mapping saved."));
}

export async function saveCategorySignalMapping(formData: FormData) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) redirect("/auth/login");
    try {
        const categoryId = read(formData, "category_id");
        const rows = parseMappings(read(formData, "mappings"));
        const { error } = await supabase.rpc("replace_category_signal_mappings", { p_category_id: categoryId, p_rows: rows });
        if (error) throw new Error(error.message);
    } catch (error) {
        redirect(message("error", error instanceof Error ? error.message : "Mapping could not be saved."));
    }
    revalidatePath("/market-intelligence/settings");
    redirect(message("success", "Category signal mapping saved."));
}
