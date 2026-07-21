"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import {
    Activity,
    Archive,
    BarChart3,
    BrainCircuit,
    BookOpenText,
    ChevronRight,
    FileUp,
    Gauge,
    Menu,
    Newspaper,
    PiggyBank,
    Settings,
    Target,
    TrendingUp,
    WalletCards,
    X,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
    { href: "/dashboard", label: "Dashboard", description: "Portfolio overview", icon: Gauge },
    { href: "/monthly-review", label: "Monthly Review", description: "Growth & currency", icon: TrendingUp },
    { href: "/market-intelligence", label: "Market Intelligence", description: "Signals & SIP decisions", icon: BrainCircuit },
    { href: "/news-events", label: "News & Events", description: "Market-impact evidence", icon: Newspaper },
    { href: "/swing-lab", label: "Swing Lab", description: "Candidates & trade journal", icon: Activity },
    { href: "/holdings", label: "Holdings", description: "Current assets", icon: WalletCards },
    { href: "/sip-plan", label: "SIP Plan", description: "Planned investments", icon: PiggyBank },
    { href: "/targets", label: "Targets", description: "Allocation goals", icon: Target },
    { href: "/snapshots", label: "Snapshots", description: "Monthly history", icon: BarChart3 },
    { href: "/notes", label: "Notes", description: "Investment plan", icon: BookOpenText },
    { href: "/archive", label: "Archive", description: "Restore old records", icon: Archive },
    { href: "/import-export", label: "Backup", description: "Import & export", icon: FileUp },
    { href: "/settings", label: "Settings", description: "Profile & categories", icon: Settings },
];

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
    const pathname = usePathname();

    return (
        <nav aria-label="Portfolio navigation" className="space-y-1.5">
            {navItems.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                const Icon = item.icon;

                return (
                    <Link
                        key={item.href}
                        href={item.href}
                        onClick={onNavigate}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                            "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition",
                            active
                                ? "bg-slate-950 text-white shadow-sm"
                                : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"
                        )}
                    >
                        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                            <span className="block font-medium">{item.label}</span>
                            <span className={cn("block truncate text-xs", active ? "text-slate-300" : "text-slate-400")}>
                                {item.description}
                            </span>
                        </span>
                        <ChevronRight className={cn("h-4 w-4", active ? "opacity-100" : "opacity-0 group-hover:opacity-40")} aria-hidden="true" />
                    </Link>
                );
            })}
        </nav>
    );
}

export function AppShell({
    children,
    displayName,
    email,
    signOutAction,
}: {
    children: ReactNode;
    displayName: string;
    email: string;
    signOutAction: () => Promise<void>;
}) {
    const [mobileOpen, setMobileOpen] = useState(false);

    return (
        <div className="min-h-screen bg-slate-50 text-slate-950">
            <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 border-r border-slate-200 bg-white lg:flex lg:flex-col">
                <div className="border-b border-slate-100 px-6 py-6">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-600">Personal portfolio</p>
                    <p className="mt-2 text-xl font-bold tracking-tight">Investment Tracker</p>
                    <p className="mt-1 truncate text-sm text-slate-500">{displayName || email}</p>
                </div>

                <div className="flex-1 overflow-y-auto px-4 py-5">
                    <Navigation />
                </div>

                <form action={signOutAction} className="border-t border-slate-100 p-4">
                    <button type="submit" className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400">
                        Sign out
                    </button>
                </form>
            </aside>

            <div className="lg:pl-72">
                <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur lg:hidden">
                    <div className="flex items-center justify-between px-4 py-3">
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">Portfolio</p>
                            <p className="font-bold">Investment Tracker</p>
                        </div>
                        <button
                            type="button"
                            aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
                            aria-expanded={mobileOpen}
                            onClick={() => setMobileOpen((open) => !open)}
                            className="rounded-lg border border-slate-200 p-2 text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                        >
                            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
                        </button>
                    </div>
                    {mobileOpen && (
                        <div className="max-h-[calc(100vh-65px)] overflow-y-auto border-t border-slate-100 bg-white px-4 py-4">
                            <Navigation onNavigate={() => setMobileOpen(false)} />
                            <form action={signOutAction} className="mt-4 border-t border-slate-100 pt-4">
                                <button type="submit" className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700">Sign out</button>
                            </form>
                        </div>
                    )}
                </header>

                {children}
            </div>
        </div>
    );
}
