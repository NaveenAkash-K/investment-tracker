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

export async function updateProfileSettings(formData: FormData) {
    const { supabase, userId } = await getSessionContext();

    const displayName = readText(formData, "display_name");
    const baseCurrency = readText(formData, "base_currency") || "INR";
    const defaultUsdInrRate = readNumber(
        formData,
        "default_usd_inr_rate",
        1
    );

    if (displayName.length > 120) {
        throw new Error("Display name should be 120 characters or less.");
    }

    if (baseCurrency !== "INR") {
        throw new Error("Only INR base currency is supported.");
    }

    if (defaultUsdInrRate <= 0) {
        throw new Error("Default USD/INR rate must be greater than zero.");
    }

    const { error } = await supabase.from("profiles").upsert(
        {
            user_id: userId,
            display_name: displayName || null,
            base_currency: baseCurrency,
            default_usd_inr_rate: defaultUsdInrRate,
        },
        {
            onConflict: "user_id",
        }
    );

    if (error) {
        throw new Error(error.message);
    }

    revalidatePath("/settings");
    revalidatePath("/holdings");
    redirect("/settings");
}

export async function signOutFromSettings() {
    const supabase = await createClient();
    await supabase.auth.signOut();

    redirect("/auth/login");
}