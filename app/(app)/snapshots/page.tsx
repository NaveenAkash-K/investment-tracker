import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createCurrentMonthSnapshot, deleteSnapshot } from "./actions";
import {PageHeader} from "@/components/page-header";

type PortfolioSnapshot = {
    id: string;
    snapshot_month: string;
    total_value_inr: number | string | null;
    total_monthly_sip: number | string | null;
    note_title: string | null;
    note_content: string | null;
    created_at: string | null;
};

type SnapshotCategory = {
    id: string;
    snapshot_id: string;
    category_name: string;
    amount_inr: number | string | null;
    current_percentage: number | string | null;
    target_percentage: number | string | null;
    difference_percentage: number | string | null;
};

type SnapshotSip = {
    id: string;
    snapshot_id: string;
    category_name: string;
    name: string;
    monthly_amount: number | string | null;
};

type SnapshotWithDetails = PortfolioSnapshot & {
    categories: SnapshotCategory[];
    sips: SnapshotSip[];
};

function toNumber(value: unknown): number {
    const numberValue = Number(value ?? 0);
    return Number.isFinite(numberValue) ? numberValue : 0;
}

function formatCurrency(value: number): string {
    return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0,
    }).format(value);
}

function formatPercent(value: number): string {
    return `${value.toFixed(2)}%`;
}

function formatMonth(value: string): string {
    return new Intl.DateTimeFormat("en-IN", {
        month: "long",
        year: "numeric",
    }).format(new Date(value));
}

function formatDateTime(value: string | null | undefined): string {
    if (!value) return "-";

    return new Intl.DateTimeFormat("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    }).format(new Date(value));
}

function getStatus(differencePercentage: number) {
    if (differencePercentage > 2) return "Overweight";
    if (differencePercentage < -2) return "Underweight";
    return "Near target";
}

function getStatusClasses(status: string): string {
    if (status === "Overweight") {
        return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
    }

    if (status === "Underweight") {
        return "bg-red-50 text-red-700 ring-1 ring-red-200";
    }

    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
}

function groupSipsByCategory(sips: SnapshotSip[]) {
    const grouped = new Map<string, SnapshotSip[]>();

    for (const sip of sips) {
        const existing = grouped.get(sip.category_name) ?? [];
        existing.push(sip);
        grouped.set(sip.category_name, existing);
    }

    return Array.from(grouped.entries()).map(([categoryName, categorySips]) => ({
        categoryName,
        sips: categorySips,
        total: categorySips.reduce(
            (sum, sip) => sum + toNumber(sip.monthly_amount),
            0
        ),
    }));
}

export default async function SnapshotsPage() {
    const supabase = await createClient();

    const {
        data: { user },
        error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
        redirect("/auth/login");
    }

    const [snapshotsResult, snapshotCategoriesResult, snapshotSipsResult] =
        await Promise.all([
            supabase
                .from("portfolio_snapshots")
                .select(
                    "id, snapshot_month, total_value_inr, total_monthly_sip, note_title, note_content, created_at"
                )
                .eq("user_id", user.id)
                .order("snapshot_month", { ascending: false }),

            supabase
                .from("snapshot_categories")
                .select(
                    "id, snapshot_id, category_name, amount_inr, current_percentage, target_percentage, difference_percentage"
                )
                .eq("user_id", user.id),

            supabase
                .from("snapshot_sips")
                .select("id, snapshot_id, category_name, name, monthly_amount")
                .eq("user_id", user.id),
        ]);

    const queryError =
        snapshotsResult.error ||
        snapshotCategoriesResult.error ||
        snapshotSipsResult.error;

    if (queryError) {
        return (
            <main className="mx-auto max-w-6xl px-4 py-8">
                <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-red-800">
                    <h1 className="text-xl font-semibold">Snapshots error</h1>
                    <p className="mt-2 text-sm">{queryError.message}</p>
                </div>
            </main>
        );
    }

    const snapshots = (snapshotsResult.data ?? []) as PortfolioSnapshot[];
    const snapshotCategories =
        (snapshotCategoriesResult.data ?? []) as SnapshotCategory[];
    const snapshotSips = (snapshotSipsResult.data ?? []) as SnapshotSip[];

    const categoriesBySnapshotId = new Map<string, SnapshotCategory[]>();
    const sipsBySnapshotId = new Map<string, SnapshotSip[]>();

    for (const category of snapshotCategories) {
        const existing = categoriesBySnapshotId.get(category.snapshot_id) ?? [];
        existing.push(category);
        categoriesBySnapshotId.set(category.snapshot_id, existing);
    }

    for (const sip of snapshotSips) {
        const existing = sipsBySnapshotId.get(sip.snapshot_id) ?? [];
        existing.push(sip);
        sipsBySnapshotId.set(sip.snapshot_id, existing);
    }

    const snapshotsWithDetails: SnapshotWithDetails[] = snapshots.map(
        (snapshot) => ({
            ...snapshot,
            categories: categoriesBySnapshotId.get(snapshot.id) ?? [],
            sips: sipsBySnapshotId.get(snapshot.id) ?? [],
        })
    );

    const latestSnapshot = snapshotsWithDetails[0] ?? null;
    const firstSnapshot = snapshotsWithDetails.at(-1) ?? null;

    const portfolioGrowth =
        latestSnapshot && firstSnapshot && latestSnapshot.id !== firstSnapshot.id
            ? toNumber(latestSnapshot.total_value_inr) -
            toNumber(firstSnapshot.total_value_inr)
            : 0;

    const currentMonthStart = new Date();
    currentMonthStart.setDate(1);
    currentMonthStart.setHours(0, 0, 0, 0);

    const hasCurrentMonthSnapshot = snapshots.some((snapshot) => {
        const snapshotMonth = new Date(snapshot.snapshot_month);
        return (
            snapshotMonth.getFullYear() === currentMonthStart.getFullYear() &&
            snapshotMonth.getMonth() === currentMonthStart.getMonth()
        );
    });

    return (
        <main className="min-h-screen bg-slate-50">
            <div className="mx-auto max-w-7xl px-4 py-8">
                <PageHeader
                    title="Snapshots"
                    description="Save monthly portfolio history after updating holdings, SIPs, targets, and notes."
                />

                <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <SummaryCard
                        label="Saved snapshots"
                        value={String(snapshots.length)}
                        helper="Monthly records"
                    />
                    <SummaryCard
                        label="Latest portfolio"
                        value={
                            latestSnapshot
                                ? formatCurrency(toNumber(latestSnapshot.total_value_inr))
                                : "-"
                        }
                        helper={latestSnapshot ? formatMonth(latestSnapshot.snapshot_month) : "No snapshot yet"}
                    />
                    <SummaryCard
                        label="Latest monthly SIP"
                        value={
                            latestSnapshot
                                ? formatCurrency(toNumber(latestSnapshot.total_monthly_sip))
                                : "-"
                        }
                        helper="Copied during snapshot"
                    />
                    <SummaryCard
                        label="Growth from first"
                        value={formatCurrency(portfolioGrowth)}
                        helper={
                            latestSnapshot && firstSnapshot && latestSnapshot.id !== firstSnapshot.id
                                ? `${formatMonth(firstSnapshot.snapshot_month)} to ${formatMonth(latestSnapshot.snapshot_month)}`
                                : "Needs 2 snapshots"
                        }
                    />
                </section>

                <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                            <h2 className="text-lg font-semibold text-slate-950">
                                Create monthly snapshot
                            </h2>
                            <p className="mt-1 text-sm text-slate-500">
                                Create this after you finish your monthly holdings/SIP/target/note updates.
                            </p>
                        </div>

                        {hasCurrentMonthSnapshot ? (
                            <span className="rounded-lg bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700 ring-1 ring-emerald-200">
                Current month snapshot already exists
              </span>
                        ) : (
                            <form action={createCurrentMonthSnapshot}>
                                <button
                                    type="submit"
                                    className="rounded-lg bg-slate-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
                                >
                                    Create current month snapshot
                                </button>
                            </form>
                        )}
                    </div>

                    <div className="mt-5 grid gap-4 md:grid-cols-3">
                        <InfoBox
                            title="What gets saved?"
                            text="Portfolio total, category allocation, target percentages, active SIPs, and current note."
                        />
                        <InfoBox
                            title="One per month"
                            text="The database prevents duplicate snapshots for the same month."
                        />
                        <InfoBox
                            title="Historical copy"
                            text="Old snapshots do not change even if you edit holdings, SIPs, targets, or notes later."
                        />
                    </div>
                </section>

                <section className="mt-6">
                    <div className="mb-4">
                        <h2 className="text-lg font-semibold text-slate-950">
                            Snapshot history
                        </h2>
                        <p className="mt-1 text-sm text-slate-500">
                            Open a snapshot to view its saved allocation, SIP plan, and note.
                        </p>
                    </div>

                    {snapshotsWithDetails.length > 0 ? (
                        <div className="space-y-5">
                            {snapshotsWithDetails.map((snapshot) => {
                                const groupedSips = groupSipsByCategory(snapshot.sips);

                                return (
                                    <article
                                        key={snapshot.id}
                                        className="overflow-hidden rounded-xl border border-slate-200 bg-white"
                                    >
                                        <div className="flex flex-col gap-4 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
                                            <div>
                                                <h3 className="text-xl font-semibold text-slate-950">
                                                    {formatMonth(snapshot.snapshot_month)}
                                                </h3>
                                                <p className="mt-1 text-sm text-slate-500">
                                                    Created {formatDateTime(snapshot.created_at)}
                                                </p>
                                            </div>

                                            <div className="flex flex-wrap gap-3 sm:justify-end">
                                                <div className="rounded-lg bg-slate-50 px-4 py-2 text-right">
                                                    <p className="text-xs text-slate-500">
                                                        Portfolio value
                                                    </p>
                                                    <p className="font-semibold text-slate-950">
                                                        {formatCurrency(toNumber(snapshot.total_value_inr))}
                                                    </p>
                                                </div>

                                                <div className="rounded-lg bg-slate-50 px-4 py-2 text-right">
                                                    <p className="text-xs text-slate-500">
                                                        Monthly SIP
                                                    </p>
                                                    <p className="font-semibold text-slate-950">
                                                        {formatCurrency(toNumber(snapshot.total_monthly_sip))}
                                                    </p>
                                                </div>
                                            </div>
                                        </div>

                                        <details>
                                            <summary className="cursor-pointer px-5 py-4 text-sm font-medium text-slate-700 hover:bg-slate-50">
                                                View snapshot details
                                            </summary>

                                            <div className="border-t border-slate-200">
                                                <div className="overflow-x-auto">
                                                    <table className="w-full min-w-[780px] text-left text-sm">
                                                        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                                        <tr>
                                                            <th className="px-5 py-3">Category</th>
                                                            <th className="px-5 py-3 text-right">
                                                                Amount
                                                            </th>
                                                            <th className="px-5 py-3 text-right">
                                                                Current %
                                                            </th>
                                                            <th className="px-5 py-3 text-right">
                                                                Target %
                                                            </th>
                                                            <th className="px-5 py-3 text-right">
                                                                Difference
                                                            </th>
                                                            <th className="px-5 py-3">Status</th>
                                                        </tr>
                                                        </thead>

                                                        <tbody className="divide-y divide-slate-100">
                                                        {snapshot.categories.map((category) => {
                                                            const difference = toNumber(
                                                                category.difference_percentage
                                                            );
                                                            const status = getStatus(difference);

                                                            return (
                                                                <tr
                                                                    key={category.id}
                                                                    className="text-slate-700"
                                                                >
                                                                    <td className="px-5 py-4 font-medium text-slate-950">
                                                                        {category.category_name}
                                                                    </td>
                                                                    <td className="px-5 py-4 text-right">
                                                                        {formatCurrency(toNumber(category.amount_inr))}
                                                                    </td>
                                                                    <td className="px-5 py-4 text-right">
                                                                        {formatPercent(
                                                                            toNumber(category.current_percentage)
                                                                        )}
                                                                    </td>
                                                                    <td className="px-5 py-4 text-right">
                                                                        {formatPercent(
                                                                            toNumber(category.target_percentage)
                                                                        )}
                                                                    </td>
                                                                    <td className="px-5 py-4 text-right">
                                                                        {formatPercent(difference)}
                                                                    </td>
                                                                    <td className="px-5 py-4">
                                      <span
                                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${getStatusClasses(
                                              status
                                          )}`}
                                      >
                                        {status}
                                      </span>
                                                                    </td>
                                                                </tr>
                                                            );
                                                        })}
                                                        </tbody>
                                                    </table>
                                                </div>

                                                <div className="grid gap-5 border-t border-slate-200 p-5 lg:grid-cols-2">
                                                    <div>
                                                        <h4 className="font-semibold text-slate-950">
                                                            SIP plan copied in this snapshot
                                                        </h4>

                                                        {groupedSips.length > 0 ? (
                                                            <div className="mt-3 space-y-3">
                                                                {groupedSips.map((group) => (
                                                                    <div
                                                                        key={group.categoryName}
                                                                        className="rounded-lg bg-slate-50 p-4"
                                                                    >
                                                                        <div className="flex items-center justify-between gap-3">
                                                                            <p className="font-medium text-slate-950">
                                                                                {group.categoryName}
                                                                            </p>
                                                                            <p className="text-sm font-semibold text-slate-950">
                                                                                {formatCurrency(group.total)}
                                                                            </p>
                                                                        </div>

                                                                        <ul className="mt-2 space-y-1 text-sm text-slate-600">
                                                                            {group.sips.map((sip) => (
                                                                                <li
                                                                                    key={sip.id}
                                                                                    className="flex justify-between gap-3"
                                                                                >
                                                                                    <span>{sip.name}</span>
                                                                                    <span>
                                            {formatCurrency(
                                                toNumber(sip.monthly_amount)
                                            )}
                                          </span>
                                                                                </li>
                                                                            ))}
                                                                        </ul>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        ) : (
                                                            <p className="mt-3 text-sm text-slate-500">
                                                                No SIPs were saved in this snapshot.
                                                            </p>
                                                        )}
                                                    </div>

                                                    <div>
                                                        <h4 className="font-semibold text-slate-950">
                                                            Investment note copied in this snapshot
                                                        </h4>

                                                        {snapshot.note_title || snapshot.note_content ? (
                                                            <div className="mt-3 rounded-lg bg-slate-50 p-4">
                                                                <h5 className="font-medium text-slate-950">
                                                                    {snapshot.note_title ?? "Untitled note"}
                                                                </h5>
                                                                <p className="mt-3 whitespace-pre-line text-sm leading-6 text-slate-700">
                                                                    {snapshot.note_content || "No note content."}
                                                                </p>
                                                            </div>
                                                        ) : (
                                                            <p className="mt-3 text-sm text-slate-500">
                                                                No current note was saved in this snapshot.
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>

                                                <div className="flex justify-end border-t border-slate-200 px-5 py-4">
                                                    <form action={deleteSnapshot}>
                                                        <input
                                                            type="hidden"
                                                            name="snapshot_id"
                                                            value={snapshot.id}
                                                        />
                                                        <button
                                                            type="submit"
                                                            className="text-sm font-medium text-red-600 hover:text-red-700"
                                                        >
                                                            Delete snapshot
                                                        </button>
                                                    </form>
                                                </div>
                                            </div>
                                        </details>
                                    </article>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="rounded-xl border border-slate-200 bg-white px-5 py-10 text-center text-sm text-slate-500">
                            No snapshots yet. Create your first monthly snapshot above.
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

function InfoBox({ title, text }: { title: string; text: string }) {
    return (
        <div className="rounded-lg bg-slate-50 p-4">
            <h3 className="text-sm font-semibold text-slate-950">{title}</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">{text}</p>
        </div>
    );
}