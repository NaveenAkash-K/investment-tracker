"use client";

import { useFormStatus } from "react-dom";
import { cn } from "@/lib/utils";

export function ConfirmSubmitButton({
    children,
    confirmation,
    pendingText = "Working...",
    pendingLabel,
    className,
    disabled = false,
}: {
    children: React.ReactNode;
    confirmation: string;
    pendingText?: string;
    pendingLabel?: string;
    className?: string;
    disabled?: boolean;
}) {
    const { pending } = useFormStatus();

    return (
        <button
            type="submit"
            disabled={pending || disabled}
            onClick={(event) => {
                if (!window.confirm(confirmation)) event.preventDefault();
            }}
            className={cn(
                "rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:cursor-wait disabled:opacity-60",
                className
            )}
        >
            {pending ? (pendingLabel ?? pendingText) : children}
        </button>
    );
}
