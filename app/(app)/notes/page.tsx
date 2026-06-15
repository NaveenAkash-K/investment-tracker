import type {
    InputHTMLAttributes,
    ReactNode,
    TextareaHTMLAttributes,
} from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
    addNote,
    deleteNote,
    markNoteAsCurrent,
    updateNote,
} from "./actions";
import {PageHeader} from "@/components/page-header";

type InvestmentNote = {
    id: string;
    title: string;
    content: string;
    is_current: boolean;
    created_at: string | null;
    updated_at: string | null;
};

function formatDateTime(value: string | null | undefined): string {
    if (!value) return "Not saved yet";

    return new Intl.DateTimeFormat("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    }).format(new Date(value));
}

function getWordCount(content: string): number {
    const trimmedContent = content.trim();

    if (!trimmedContent) {
        return 0;
    }

    return trimmedContent.split(/\s+/).length;
}

function getPreview(content: string): string {
    if (!content.trim()) {
        return "No content yet.";
    }

    if (content.length <= 260) {
        return content;
    }

    return `${content.slice(0, 260)}...`;
}

export default async function NotesPage() {
    const supabase = await createClient();

    const {
        data: { user },
        error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
        redirect("/auth/login");
    }

    const { data, error } = await supabase
        .from("investment_notes")
        .select("id, title, content, is_current, created_at, updated_at")
        .eq("user_id", user.id)
        .order("is_current", { ascending: false })
        .order("updated_at", { ascending: false });

    if (error) {
        return (
            <main className="mx-auto max-w-6xl px-4 py-8">
                <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-red-800">
                    <h1 className="text-xl font-semibold">Notes error</h1>
                    <p className="mt-2 text-sm">{error.message}</p>
                </div>
            </main>
        );
    }

    const notes = (data ?? []) as InvestmentNote[];
    const currentNote = notes.find((note) => note.is_current) ?? notes[0] ?? null;

    const totalWords = notes.reduce(
        (sum, note) => sum + getWordCount(note.content),
        0
    );

    return (
        <main className="min-h-screen bg-slate-50">
            <div className="mx-auto max-w-7xl px-4 py-8">
                <PageHeader
                    title="Notes"
                    description="Write your current investment plan, save previous versions, and mark one as the current plan."
                />

                <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <SummaryCard
                        label="Saved notes"
                        value={String(notes.length)}
                        helper="Investment plan versions"
                    />
                    <SummaryCard
                        label="Current plan"
                        value={currentNote ? currentNote.title : "None"}
                        helper={currentNote ? "Shown on dashboard" : "Create a note below"}
                    />
                    <SummaryCard
                        label="Total words"
                        value={String(totalWords)}
                        helper="Across all notes"
                    />
                    <SummaryCard
                        label="Last updated"
                        value={currentNote ? formatDateTime(currentNote.updated_at) : "-"}
                        helper="Current/latest note"
                    />
                </section>

                {currentNote && (
                    <section className="mt-6 rounded-xl border border-blue-200 bg-blue-50 p-5">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <h2 className="text-lg font-semibold text-blue-950">
                                        {currentNote.title}
                                    </h2>
                                    {currentNote.is_current && (
                                        <span className="rounded-full bg-blue-100 px-2.5 py-1 text-xs font-medium text-blue-700 ring-1 ring-blue-200">
                      Current plan
                    </span>
                                    )}
                                </div>
                                <p className="mt-1 text-sm text-blue-700">
                                    Updated {formatDateTime(currentNote.updated_at)}
                                </p>
                            </div>
                        </div>

                        <p className="mt-4 whitespace-pre-line text-sm leading-6 text-blue-950">
                            {currentNote.content || "No content yet."}
                        </p>
                    </section>
                )}

                <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
                    <div className="mb-5">
                        <h2 className="text-lg font-semibold text-slate-950">
                            Add new note
                        </h2>
                        <p className="mt-1 text-sm text-slate-500">
                            Use this for your monthly or tactical investment plan.
                        </p>
                    </div>

                    <form action={addNote} className="space-y-4">
                        <div>
                            <Label htmlFor="title">Title</Label>
                            <Input
                                id="title"
                                name="title"
                                placeholder="June 2026 Investment Plan"
                                required
                            />
                        </div>

                        <div>
                            <Label htmlFor="content">Plan content</Label>
                            <Textarea
                                id="content"
                                name="content"
                                rows={10}
                                placeholder={`Current view:
Indian equity still looks attractive.
Keep equity SIP strong, but do not ignore debt completely.

Temporary plan:
- Indian equity: ₹25,000
- US equity: ₹5,000
- Debt: ₹7,000
- Gold/Silver: ₹1,000
- Crypto: ₹2,000

Review again after 3 months.`}
                            />
                        </div>

                        <label className="flex items-center gap-2 text-sm text-slate-700">
                            <input
                                type="checkbox"
                                name="is_current"
                                className="h-4 w-4 rounded border-slate-300"
                            />
                            Mark as current plan
                        </label>

                        <button
                            type="submit"
                            className="rounded-lg bg-slate-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
                        >
                            Save note
                        </button>
                    </form>
                </section>

                <section className="mt-6">
                    <div className="mb-4">
                        <h2 className="text-lg font-semibold text-slate-950">
                            Previous notes
                        </h2>
                        <p className="mt-1 text-sm text-slate-500">
                            Keep track of how your investment thinking changed over time.
                        </p>
                    </div>

                    {notes.length > 0 ? (
                        <div className="grid gap-4 lg:grid-cols-2">
                            {notes.map((note) => (
                                <article
                                    key={note.id}
                                    className="rounded-xl border border-slate-200 bg-white p-5"
                                >
                                    <div className="flex items-start justify-between gap-4">
                                        <div>
                                            <div className="flex flex-wrap items-center gap-2">
                                                <h3 className="font-semibold text-slate-950">
                                                    {note.title}
                                                </h3>

                                                {note.is_current && (
                                                    <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 ring-1 ring-blue-200">
                            Current
                          </span>
                                                )}
                                            </div>

                                            <p className="mt-1 text-sm text-slate-500">
                                                Updated {formatDateTime(note.updated_at)} ·{" "}
                                                {getWordCount(note.content)} words
                                            </p>
                                        </div>
                                    </div>

                                    <p className="mt-4 whitespace-pre-line rounded-lg bg-slate-50 p-3 text-sm leading-6 text-slate-700">
                                        {getPreview(note.content)}
                                    </p>

                                    <div className="mt-4 flex flex-wrap gap-3">
                                        {!note.is_current && (
                                            <form action={markNoteAsCurrent}>
                                                <input type="hidden" name="note_id" value={note.id} />
                                                <button
                                                    type="submit"
                                                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                                                >
                                                    Mark current
                                                </button>
                                            </form>
                                        )}

                                        <form action={deleteNote}>
                                            <input type="hidden" name="note_id" value={note.id} />
                                            <button
                                                type="submit"
                                                className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
                                            >
                                                Delete
                                            </button>
                                        </form>
                                    </div>

                                    <details className="mt-4 rounded-lg border border-slate-200">
                                        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-slate-700">
                                            Edit note
                                        </summary>

                                        <form
                                            action={updateNote}
                                            className="space-y-4 border-t border-slate-200 p-4"
                                        >
                                            <input type="hidden" name="note_id" value={note.id} />

                                            <div>
                                                <Label htmlFor={`title_${note.id}`}>Title</Label>
                                                <Input
                                                    id={`title_${note.id}`}
                                                    name="title"
                                                    defaultValue={note.title}
                                                    required
                                                />
                                            </div>

                                            <div>
                                                <Label htmlFor={`content_${note.id}`}>Content</Label>
                                                <Textarea
                                                    id={`content_${note.id}`}
                                                    name="content"
                                                    rows={10}
                                                    defaultValue={note.content}
                                                />
                                            </div>

                                            <label className="flex items-center gap-2 text-sm text-slate-700">
                                                <input
                                                    type="checkbox"
                                                    name="is_current"
                                                    defaultChecked={note.is_current}
                                                    className="h-4 w-4 rounded border-slate-300"
                                                />
                                                Mark as current plan
                                            </label>

                                            <button
                                                type="submit"
                                                className="rounded-lg bg-slate-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
                                            >
                                                Save changes
                                            </button>
                                        </form>
                                    </details>
                                </article>
                            ))}
                        </div>
                    ) : (
                        <div className="rounded-xl border border-slate-200 bg-white px-5 py-10 text-center text-sm text-slate-500">
                            No notes yet. Add your first investment plan above.
                        </div>
                    )}
                </section>
            </div>
        </main>
    );
}

function SummaryCard({
                         label,
                         value,
                         helper,
                     }: {
    label: string;
    value: string;
    helper: string;
}) {
    return (
        <div className="rounded-xl border border-slate-200 bg-white p-5">
            <p className="text-sm font-medium text-slate-500">{label}</p>
            <p className="mt-2 text-2xl font-bold text-slate-950">{value}</p>
            <p className="mt-1 text-sm text-slate-500">{helper}</p>
        </div>
    );
}

function Label({
                   htmlFor,
                   children,
               }: {
    htmlFor: string;
    children: ReactNode;
}) {
    return (
        <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-700">
            {children}
        </label>
    );
}

function Input({
                   className = "",
                   ...props
               }: InputHTMLAttributes<HTMLInputElement>) {
    return (
        <input
            {...props}
            className={`mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950 outline-none ring-slate-300 focus:ring-2 ${className}`}
        />
    );
}

function Textarea({
                      className = "",
                      ...props
                  }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
    return (
        <textarea
            {...props}
            className={`mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm leading-6 text-slate-950 outline-none ring-slate-300 focus:ring-2 ${className}`}
        />
    );
}