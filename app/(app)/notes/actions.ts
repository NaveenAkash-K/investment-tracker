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

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

async function assertNoteBelongsToUser(
    supabase: SupabaseServerClient,
    userId: string,
    noteId: string
) {
    const { data, error } = await supabase
        .from("investment_notes")
        .select("id")
        .eq("id", noteId)
        .eq("user_id", userId)
        .maybeSingle();

    if (error || !data) {
        throw new Error("Invalid note.");
    }
}

async function unsetCurrentNotes(
    supabase: SupabaseServerClient,
    userId: string
) {
    const { error } = await supabase
        .from("investment_notes")
        .update({ is_current: false })
        .eq("user_id", userId)
        .eq("is_current", true);

    if (error) {
        throw new Error(error.message);
    }
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
    const { supabase, userId } = await getSessionContext();

    const title = readText(formData, "title");
    const content = readText(formData, "content");
    const makeCurrent = readCheckbox(formData, "is_current");

    validateNoteInput({ title });

    const { data: existingNotes, error: existingNotesError } = await supabase
        .from("investment_notes")
        .select("id")
        .eq("user_id", userId)
        .limit(1);

    if (existingNotesError) {
        throw new Error(existingNotesError.message);
    }

    const shouldBeCurrent = makeCurrent || (existingNotes ?? []).length === 0;

    if (shouldBeCurrent) {
        await unsetCurrentNotes(supabase, userId);
    }

    const { error } = await supabase.from("investment_notes").insert({
        user_id: userId,
        title,
        content,
        is_current: shouldBeCurrent,
    });

    if (error) {
        throw new Error(error.message);
    }

    revalidatePath("/notes");
    revalidatePath("/dashboard");
    redirect("/notes");
}

export async function updateNote(formData: FormData) {
    const { supabase, userId } = await getSessionContext();

    const noteId = readText(formData, "note_id");
    const title = readText(formData, "title");
    const content = readText(formData, "content");
    const makeCurrent = readCheckbox(formData, "is_current");

    if (!noteId) {
        throw new Error("Note ID is required.");
    }

    validateNoteInput({ title });

    await assertNoteBelongsToUser(supabase, userId, noteId);

    if (makeCurrent) {
        await unsetCurrentNotes(supabase, userId);
    }

    const { error } = await supabase
        .from("investment_notes")
        .update({
            title,
            content,
            is_current: makeCurrent,
        })
        .eq("id", noteId)
        .eq("user_id", userId);

    if (error) {
        throw new Error(error.message);
    }

    revalidatePath("/notes");
    revalidatePath("/dashboard");
    redirect("/notes");
}

export async function markNoteAsCurrent(formData: FormData) {
    const { supabase, userId } = await getSessionContext();

    const noteId = readText(formData, "note_id");

    if (!noteId) {
        throw new Error("Note ID is required.");
    }

    await assertNoteBelongsToUser(supabase, userId, noteId);
    await unsetCurrentNotes(supabase, userId);

    const { error } = await supabase
        .from("investment_notes")
        .update({ is_current: true })
        .eq("id", noteId)
        .eq("user_id", userId);

    if (error) {
        throw new Error(error.message);
    }

    revalidatePath("/notes");
    revalidatePath("/dashboard");
    redirect("/notes");
}

export async function deleteNote(formData: FormData) {
    const { supabase, userId } = await getSessionContext();

    const noteId = readText(formData, "note_id");

    if (!noteId) {
        throw new Error("Note ID is required.");
    }

    await assertNoteBelongsToUser(supabase, userId, noteId);

    const { error } = await supabase
        .from("investment_notes")
        .delete()
        .eq("id", noteId)
        .eq("user_id", userId);

    if (error) {
        throw new Error(error.message);
    }

    revalidatePath("/notes");
    revalidatePath("/dashboard");
    redirect("/notes");
}