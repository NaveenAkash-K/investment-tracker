"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function text(formData: FormData, key: string) {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
}

export async function resolveAnalyzerDelivery(formData: FormData) {
    const returnTo = text(formData, "return_to") === "/swing-lab"
        ? "/swing-lab"
        : "/market-intelligence";
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) redirect("/auth/login");

    const deliveryId = text(formData, "delivery_id");
    const action = text(formData, "resolution_action");
    const note = text(formData, "resolution_note");
    if (!deliveryId || !["retry", "dismiss"].includes(action)) {
        redirect(`${returnTo}?error=${encodeURIComponent("Invalid notification resolution.")}`);
    }

    const { error } = await supabase.rpc("resolve_analyzer_notification_delivery", {
        p_delivery_id: deliveryId,
        p_action: action,
        p_note: note || null,
    });
    if (error) redirect(`${returnTo}?error=${encodeURIComponent(error.message)}`);

    revalidatePath("/market-intelligence");
    revalidatePath("/swing-lab");
    const message = action === "retry"
        ? "The next rerun may retry this email."
        : "The unresolved email was dismissed.";
    redirect(`${returnTo}?success=${encodeURIComponent(message)}`);
}
