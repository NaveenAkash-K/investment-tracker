"use client";

import { useFormStatus } from "react-dom";
import { cn } from "@/lib/utils";

export function FormSubmitButton({
    children,
    pendingText = "Saving...",
    pendingLabel,
    className,
}: {
    children: React.ReactNode;
    pendingText?: string;
    pendingLabel?: string;
    className?: string;
}) {
    const { pending } = useFormStatus();

    return (
        <button
            type="submit"
            disabled={pending}
            aria-disabled={pending}
            className={cn(
                "rounded-lg bg-slate-950 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60",
                className
            )}
        >
            {pending ? (pendingLabel ?? pendingText) : children}
        </button>
    );
}
