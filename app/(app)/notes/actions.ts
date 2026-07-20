"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function readText(formData: FormData, key: string): string {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
}

function readCheckbox(formData: FormData, key: string): boolean {
    return formData.get(key) === "on";
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

function validateNoteInput({
                               title,
                           }: {
    title: string;
}) {
    if (!title) {
        throw new Error("Note title is required.");
    }

    if (title.length > 120) {
        throw new Error("Note title should be 120 characters or less.");
    }
}

export async function addNote(formData: FormData) {
    const { supabase } = await getSessionContext();

    const title = readText(formData, "title");
    const content = readText(formData, "content");
    const makeCurrent = readCheckbox(formData, "is_current");

    validateNoteInput({ title });

    const { error } = await supabase.rpc("save_investment_note", {
        p_note_id: null,
        p_title: title,
        p_content: content,
        p_make_current: makeCurrent,
    });

    if (error) {
        throw new Error(error.message);
    }

    revalidatePath("/notes");
    revalidatePath("/dashboard");
    redirect("/notes");
}

export async function updateNote(formData: FormData) {
    const { supabase } = await getSessionContext();

    const noteId = readText(formData, "note_id");
    const title = readText(formData, "title");
    const content = readText(formData, "content");
    const makeCurrent = readCheckbox(formData, "is_current");

    if (!noteId) {
        throw new Error("Note ID is required.");
    }

    validateNoteInput({ title });

    const { error } = await supabase.rpc("save_investment_note", {
        p_note_id: noteId,
        p_title: title,
        p_content: content,
        p_make_current: makeCurrent,
    });

    if (error) {
        throw new Error(error.message);
    }

    revalidatePath("/notes");
    revalidatePath("/dashboard");
    redirect("/notes");
}

export async function markNoteAsCurrent(formData: FormData) {
    const { supabase } = await getSessionContext();

    const noteId = readText(formData, "note_id");

    if (!noteId) {
        throw new Error("Note ID is required.");
    }

    const { error } = await supabase.rpc("set_current_investment_note", {
        p_note_id: noteId,
    });

    if (error) {
        throw new Error(error.message);
    }

    revalidatePath("/notes");
    revalidatePath("/dashboard");
    redirect("/notes");
}

export async function deleteNote(formData: FormData) {
    const { supabase } = await getSessionContext();

    const noteId = readText(formData, "note_id");

    if (!noteId) {
        throw new Error("Note ID is required.");
    }

    const { error } = await supabase.rpc("delete_investment_note", {
        p_note_id: noteId,
    });

    if (error) {
        throw new Error(error.message);
    }

    revalidatePath("/notes");
    revalidatePath("/dashboard");
    redirect("/notes");
}
