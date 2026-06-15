import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";

const navItems = [
    {
        href: "/dashboard",
        label: "Dashboard",
        description: "Overview",
    },
    {
        href: "/holdings",
        label: "Holdings",
        description: "Current assets",
    },
    {
        href: "/sip-plan",
        label: "SIP Plan",
        description: "Monthly investments",
    },
    {
        href: "/targets",
        label: "Targets",
        description: "Allocation goals",
    },
    {
        href: "/notes",
        label: "Notes",
        description: "Current plan",
    },
    {
        href: "/snapshots",
        label: "Snapshots",
        description: "Monthly history",
    },
    {
        href: "/import-export",
        label: "Import / Export",
        description: "CSV backup",
    },
    {
        href: "/settings",
        label: "Settings",
        description: "Profile & defaults",
    },
];

export default function ProtectedAppLayout({
                                               children,
                                           }: {
    children: React.ReactNode;
}) {
    return (
        <Suspense fallback={<ProtectedAppLoading />}>
            <ProtectedAppGate>{children}</ProtectedAppGate>
        </Suspense>
    );
}

async function ProtectedAppGate({
                                    children,
                                }: {
    children: React.ReactNode;
}) {
    const supabase = await createClient();

    const {
        data: { user },
        error,
    } = await supabase.auth.getUser();

    if (error || !user) {
        redirect("/auth/login");
    }

    async function signOut() {
        "use server";

        const supabase = await createClient();
        await supabase.auth.signOut();

        redirect("/auth/login");
    }

    return (
        <div className="min-h-screen bg-slate-50 text-slate-950">
            <aside className="fixed inset-y-0 left-0 hidden w-72 border-r border-slate-200 bg-white p-5 lg:block">
                <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                        Portfolio
                    </p>
                    <h1 className="mt-2 text-xl font-bold text-slate-950">
                        Investment Tracker
                    </h1>
                    <p className="mt-1 text-sm text-slate-500">
                        Personal allocation dashboard
                    </p>
                </div>

                <nav className="mt-8 space-y-2">
                    {navItems.map((item) => (
                        <Link
                            key={item.href}
                            href={item.href}
                            className="block rounded-xl px-4 py-3 text-sm transition hover:bg-slate-100"
                        >
                            <span className="font-medium text-slate-950">{item.label}</span>
                            <span className="mt-0.5 block text-xs text-slate-500">
                {item.description}
              </span>
                        </Link>
                    ))}
                </nav>

                <form action={signOut} className="absolute bottom-5 left-5 right-5">
                    <button
                        type="submit"
                        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-100"
                    >
                        Sign out
                    </button>
                </form>
            </aside>

            <div className="lg:pl-72">
                <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur lg:hidden">
                    <div className="px-4 py-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                            Portfolio
                        </p>
                        <h1 className="text-lg font-bold text-slate-950">
                            Investment Tracker
                        </h1>
                    </div>

                    <nav className="flex gap-2 overflow-x-auto border-t border-slate-100 px-4 py-3">
                        {navItems.map((item) => (
                            <Link
                                key={item.href}
                                href={item.href}
                                className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700"
                            >
                                {item.label}
                            </Link>
                        ))}
                    </nav>
                </header>

                {children}
            </div>
        </div>
    );
}

function ProtectedAppLoading() {
    return (
        <main className="min-h-screen bg-slate-50 px-4 py-24">
            <div className="mx-auto max-w-2xl rounded-xl border border-slate-200 bg-white p-6 text-center">
                <p className="text-sm font-medium text-slate-700">
                    Loading your portfolio...
                </p>
            </div>
        </main>
    );
}