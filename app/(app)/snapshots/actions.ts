"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

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

function readText(formData: FormData, key: string): string {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
}

export async function createCurrentMonthSnapshot() {
    const { supabase } = await getSessionContext();
    const { error } = await supabase.rpc("create_current_month_snapshot");
    if (error) throw new Error(error.message);

    revalidatePath("/snapshots");
    revalidatePath("/dashboard");
    redirect("/snapshots");
}

export async function deleteSnapshot(formData: FormData) {
    const { supabase, userId } = await getSessionContext();

    const snapshotId = readText(formData, "snapshot_id");

    if (!snapshotId) {
        throw new Error("Snapshot ID is required.");
    }

    const { error } = await supabase
        .from("portfolio_snapshots")
        .delete()
        .eq("id", snapshotId)
        .eq("user_id", userId);

    if (error) {
        throw new Error(error.message);
    }

    revalidatePath("/snapshots");
    redirect("/snapshots");
}
