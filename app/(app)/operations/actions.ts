"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function value(formData: FormData, key: string) {
    const raw = formData.get(key);
    return typeof raw === "string" ? raw.trim() : "";
}

export async function resolveNewsDelivery(formData: FormData) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) redirect("/auth/login");
    const alertId = value(formData, "alert_id");
    const resolution = value(formData, "resolution");
    if (!alertId || !["sent", "retry", "suppressed"].includes(resolution)) {
        redirect("/operations?error=Invalid+news+delivery+resolution");
    }
    const { error } = await supabase.rpc("resolve_news_alert_delivery", {
        p_alert_id: alertId,
        p_resolution: resolution,
    });
    if (error) redirect(`/operations?error=${encodeURIComponent(error.message)}`);
    revalidatePath("/operations");
    redirect("/operations?success=News+delivery+resolved");
}
