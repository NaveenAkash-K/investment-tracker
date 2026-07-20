import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
    return <div className="relative min-h-svh bg-slate-50">
        <div className="absolute inset-x-0 top-0 z-10 px-6 py-5 text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-600">Personal portfolio</p>
            <p className="mt-1 text-lg font-bold text-slate-950">Investment Tracker</p>
        </div>
        {children}
    </div>;
}
