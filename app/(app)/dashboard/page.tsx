import {redirect} from "next/navigation";
import {createClient} from "@/lib/supabase/server";
import {PageHeader} from "@/components/page-header";
import Link from "next/link";
import { getIndiaMonthStart } from "@/lib/performance";

type Category = {
    id: string;
    name: string;
    sort_order: number | null;
};

type Holding = {
    id: string;
    category_id: string;
    name: string;
    current_value_inr: number | string | null;
    is_active: boolean | null;
    last_updated_at: string | null;
};

type Target = {
    category_id: string;
    target_percentage: number | string | null;
};

type SipPlan = {
    id: string;
    category_id: string;
    name: string;
    monthly_amount: number | string | null;
    is_active: boolean | null;
};

type InvestmentNote = {
    id: string;
    title: string;
    content: string;
    is_current: boolean;
    updated_at: string;
};

type MonthlyPerformance = {
    performance_month: string;
    contribution_inr: number | string | null;
    market_gain_inr: number | string | null;
    currency_gain_inr: number | string | null;
    combined_gain_inr: number | string | null;
};

type AllocationRow = {
    categoryId: string;
    categoryName: string;
    currentAmount: number;
    currentPercentage: number;
    targetPercentage: number;
    differencePercentage: number;
    targetAmount: number;
    gapToTarget: number;
    monthlySip: number;
    sipPercentage: number;
    status: "Underweight" | "Near target" | "Overweight";
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

function formatDate(value: string | null | undefined): string {
    if (!value) return "Not updated yet";

    return new Intl.DateTimeFormat("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
    }).format(new Date(value));
}

function getStatus(differencePercentage: number): AllocationRow["status"] {
    if (differencePercentage > 2) return "Overweight";
    if (differencePercentage < -2) return "Underweight";
    return "Near target";
}

function getStatusClasses(status: AllocationRow["status"]): string {
    if (status === "Overweight") {
        return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
    }

    if (status === "Underweight") {
        return "bg-red-50 text-red-700 ring-1 ring-red-200";
    }

    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
}

function buildWarnings(rows: AllocationRow[]): string[] {
    const warnings: string[] = [];

    for (const row of rows) {
        if (row.differencePercentage < -2 && row.monthlySip === 0) {
            warnings.push(
                `${row.categoryName} is under target, but monthly SIP is currently zero.`
            );
        }

        if (row.differencePercentage > 2 && row.monthlySip > 0) {
            warnings.push(
                `${row.categoryName} is already above target, but SIP is still adding ${formatCurrency(
                    row.monthlySip
                )} per month.`
            );
        }

        // A high SIP share may intentionally correct an underweight category.
        // Warnings therefore use current portfolio drift, not SIP-vs-target alone.
    }

    return warnings;
}

export default async function DashboardPage() {
    const supabase = await createClient();

    const {
        data: {user},
        error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
        redirect("/auth/login");
    }

    const [
        categoriesResult,
        holdingsResult,
        targetsResult,
        sipPlansResult,
        notesResult,
        monthlyPerformanceResult,
    ] = await Promise.all([
        supabase
            .from("asset_categories")
            .select("id, name, sort_order")
            .eq("user_id", user.id)
            .order("sort_order", {ascending: true}),

        supabase
            .from("holdings")
            .select("id, category_id, name, current_value_inr, is_active, last_updated_at")
            .eq("user_id", user.id)
            .eq("is_active", true),

        supabase
            .from("portfolio_targets")
            .select("category_id, target_percentage")
            .eq("user_id", user.id),

        supabase
            .from("sip_plans")
            .select("id, category_id, name, monthly_amount, is_active")
            .eq("user_id", user.id)
            .eq("is_active", true),

        supabase
            .from("investment_notes")
            .select("id, title, content, is_current, updated_at")
            .eq("user_id", user.id)
            .order("is_current", {ascending: false})
            .order("updated_at", {ascending: false})
            .limit(1),

        supabase
            .from("monthly_category_performance")
            .select("performance_month, contribution_inr, market_gain_inr, currency_gain_inr, combined_gain_inr")
            .eq("user_id", user.id)
            .order("performance_month", {ascending: false})
            .limit(24),
    ]);

    const queryError =
        categoriesResult.error ||
        holdingsResult.error ||
        targetsResult.error ||
        sipPlansResult.error ||
        notesResult.error ||
        monthlyPerformanceResult.error;

    if (queryError) {
        return (
            <main className="mx-auto max-w-6xl px-4 py-8">
                <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-red-800">
                    <h1 className="text-xl font-semibold">Dashboard error</h1>
                    <p className="mt-2 text-sm">{queryError.message}</p>
                </div>
            </main>
        );
    }

    const categories = (categoriesResult.data ?? []) as Category[];
    const holdings = (holdingsResult.data ?? []) as Holding[];
    const targets = (targetsResult.data ?? []) as Target[];
    const sipPlans = (sipPlansResult.data ?? []) as SipPlan[];
    const latestNote = ((notesResult.data ?? []) as InvestmentNote[])[0];
    const performanceRows = (monthlyPerformanceResult.data ?? []) as MonthlyPerformance[];
    const latestPerformanceMonth = performanceRows[0]?.performance_month;
    const latestPerformance = performanceRows.filter((row) => row.performance_month === latestPerformanceMonth);
    const monthlyContribution = latestPerformance.reduce((sum, row) => sum + toNumber(row.contribution_inr), 0);
    const monthlyMarketGain = latestPerformance.reduce((sum, row) => sum + toNumber(row.market_gain_inr), 0);
    const monthlyCurrencyGain = latestPerformance.reduce((sum, row) => sum + toNumber(row.currency_gain_inr), 0);
    const monthlyCombinedGain = latestPerformance.reduce((sum, row) => sum + toNumber(row.combined_gain_inr), 0);

    const targetByCategoryId = new Map<string, number>();
    const amountByCategoryId = new Map<string, number>();
    const sipByCategoryId = new Map<string, number>();

    for (const target of targets) {
        targetByCategoryId.set(
            target.category_id,
            toNumber(target.target_percentage)
        );
    }

    for (const holding of holdings) {
        const previousAmount = amountByCategoryId.get(holding.category_id) ?? 0;
        amountByCategoryId.set(
            holding.category_id,
            previousAmount + toNumber(holding.current_value_inr)
        );
    }

    for (const sipPlan of sipPlans) {
        const previousAmount = sipByCategoryId.get(sipPlan.category_id) ?? 0;
        sipByCategoryId.set(
            sipPlan.category_id,
            previousAmount + toNumber(sipPlan.monthly_amount)
        );
    }

    const totalPortfolioValue = holdings.reduce(
        (sum, holding) => sum + toNumber(holding.current_value_inr),
        0
    );

    const totalMonthlySip = sipPlans.reduce(
        (sum, sipPlan) => sum + toNumber(sipPlan.monthly_amount),
        0
    );

    const oldestUpdatedDate =
        holdings
            .map((holding) => holding.last_updated_at)
            .filter(Boolean)
            .sort()
            .at(0) ?? null;
    const currentMonth = getIndiaMonthStart().slice(0, 7);
    const updatedThisMonth = holdings.filter((holding) => holding.last_updated_at?.startsWith(currentMonth)).length;

    const rows: AllocationRow[] = categories.map((category) => {
        const currentAmount = amountByCategoryId.get(category.id) ?? 0;
        const targetPercentage = targetByCategoryId.get(category.id) ?? 0;
        const monthlySip = sipByCategoryId.get(category.id) ?? 0;

        const currentPercentage =
            totalPortfolioValue > 0
                ? (currentAmount / totalPortfolioValue) * 100
                : 0;

        const sipPercentage =
            totalMonthlySip > 0 ? (monthlySip / totalMonthlySip) * 100 : 0;

        const differencePercentage = currentPercentage - targetPercentage;
        const targetAmount = (totalPortfolioValue * targetPercentage) / 100;
        const gapToTarget = targetAmount - currentAmount;

        return {
            categoryId: category.id,
            categoryName: category.name,
            currentAmount,
            currentPercentage,
            targetPercentage,
            differencePercentage,
            targetAmount,
            gapToTarget,
            monthlySip,
            sipPercentage,
            status: getStatus(differencePercentage),
        };
    });

    const warnings = buildWarnings(rows);

    return (
        <main>
            <div className="mx-auto max-w-7xl px-4 py-8">
                <PageHeader
                    title="Dashboard"
                    description="Track your portfolio allocation, SIP split, and current investment plan."
                />

                <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <SummaryCard
                        label="Total portfolio"
                        value={formatCurrency(totalPortfolioValue)}
                        helper={`${holdings.length} active holdings`}
                    />
                    <SummaryCard
                        label="Monthly SIP"
                        value={formatCurrency(totalMonthlySip)}
                        helper={`${sipPlans.length} active SIPs`}
                    />
                    <SummaryCard
                        label="Portfolio freshness"
                        value={`${updatedThisMonth}/${holdings.length}`}
                        helper={oldestUpdatedDate ? `Oldest value: ${formatDate(oldestUpdatedDate)}` : "No holding dates yet"}
                    />
                    <SummaryCard
                        label="Latest real growth"
                        value={latestPerformanceMonth ? formatCurrency(monthlyCombinedGain) : "Not tracked"}
                        helper={latestPerformanceMonth ? formatMonthLabel(latestPerformanceMonth) : "Start a monthly review"}
                    />
                </section>

                <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div><h2 className="text-lg font-semibold text-slate-950">Monthly performance</h2><p className="mt-1 text-sm text-slate-500">Contributions are separated from market movement and USD/INR movement.</p></div>
                        <Link href="/monthly-review" className="rounded-lg bg-slate-950 px-4 py-2 text-center text-sm font-medium text-white">Open monthly review</Link>
                    </div>
                    {latestPerformanceMonth ? <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                        <Metric label="Actual contribution" value={monthlyContribution} />
                        <Metric label="Market gain/loss" value={monthlyMarketGain} signed />
                        <Metric label="Currency gain/loss" value={monthlyCurrencyGain} signed />
                        <Metric label="Combined gain/loss" value={monthlyCombinedGain} signed />
                    </div> : <p className="mt-5 rounded-lg bg-blue-50 p-4 text-sm text-blue-800">Your first monthly review creates the baseline. Accurate market and currency gains begin from the next month.</p>}
                </section>

                {warnings.length > 0 && (
                    <section className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5">
                        <h2 className="text-base font-semibold text-amber-900">
                            Allocation warnings
                        </h2>
                        <ul className="mt-3 space-y-2 text-sm text-amber-800">
                            {warnings.slice(0, 5).map((warning) => (
                                <li key={warning}>• {warning}</li>
                            ))}
                        </ul>
                    </section>
                )}

                <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
                    <h2 className="text-lg font-semibold text-slate-950">Current allocation</h2>
                    <p className="mt-1 text-sm text-slate-500">A quick visual of each category&apos;s share of the active portfolio.</p>
                    <div className="mt-5 space-y-4">{rows.map((row) => <div key={row.categoryId}>
                        <div className="mb-1 flex justify-between gap-3 text-sm"><span className="font-medium text-slate-700">{row.categoryName}</span><span className="text-slate-500">{formatPercent(row.currentPercentage)} / {formatPercent(row.targetPercentage)} target</span></div>
                        <div className="relative h-3 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-blue-600" style={{width: `${Math.min(row.currentPercentage, 100)}%`}} /><span className="absolute inset-y-0 w-0.5 bg-slate-950" style={{left: `${Math.min(row.targetPercentage, 100)}%`}} /></div>
                    </div>)}</div>
                </section>

                <section className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
                    <div className="border-b border-slate-200 px-5 py-4">
                        <h2 className="text-lg font-semibold text-slate-950">
                            Portfolio allocation
                        </h2>
                        <p className="mt-1 text-sm text-slate-500">
                            Rebalance difference assumes the total stays fixed, so it describes
                            selling/reallocation—not new money required without selling.
                        </p>
                    </div>

                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[900px] text-left text-sm">
                            <caption className="sr-only">Current portfolio allocation compared with targets and planned SIPs</caption>
                            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                            <tr>
                                <th className="px-5 py-3">Asset</th>
                                <th className="px-5 py-3 text-right">Current amount</th>
                                <th className="px-5 py-3 text-right">Current %</th>
                                <th className="px-5 py-3 text-right">Target %</th>
                                <th className="px-5 py-3 text-right">Difference</th>
                                <th className="px-5 py-3 text-right">Rebalance difference</th>
                                <th className="px-5 py-3 text-right">Monthly SIP</th>
                                <th className="px-5 py-3 text-right">SIP %</th>
                                <th className="px-5 py-3">Status</th>
                            </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                            {rows.map((row) => (
                                <tr key={row.categoryId} className="text-slate-700">
                                    <td className="px-5 py-4 font-medium text-slate-950">
                                        {row.categoryName}
                                    </td>
                                    <td className="px-5 py-4 text-right">
                                        {formatCurrency(row.currentAmount)}
                                    </td>
                                    <td className="px-5 py-4 text-right">
                                        {formatPercent(row.currentPercentage)}
                                    </td>
                                    <td className="px-5 py-4 text-right">
                                        {formatPercent(row.targetPercentage)}
                                    </td>
                                    <td className="px-5 py-4 text-right">
                                        {formatPercent(row.differencePercentage)}
                                    </td>
                                    <td className="px-5 py-4 text-right">
                                        {formatCurrency(row.gapToTarget)}
                                    </td>
                                    <td className="px-5 py-4 text-right">
                                        {formatCurrency(row.monthlySip)}
                                    </td>
                                    <td className="px-5 py-4 text-right">
                                        {formatPercent(row.sipPercentage)}
                                    </td>
                                    <td className="px-5 py-4">
                      <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${getStatusClasses(
                              row.status
                          )}`}
                      >
                        {row.status}
                      </span>
                                    </td>
                                </tr>
                            ))}

                            {rows.length === 0 && (
                                <tr>
                                    <td
                                        colSpan={9}
                                        className="px-5 py-10 text-center text-slate-500"
                                    >
                                        No asset categories found. Check your Supabase schema seed.
                                    </td>
                                </tr>
                            )}
                            </tbody>
                        </table>
                    </div>
                </section>

                <section className="mt-6 grid gap-6 lg:grid-cols-2">
                    <div className="rounded-xl border border-slate-200 bg-white p-5">
                        <h2 className="text-lg font-semibold text-slate-950">
                            SIP allocation
                        </h2>
                        <div className="mt-4 space-y-3">
                            {rows.map((row) => (
                                <div key={row.categoryId}>
                                    <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="font-medium text-slate-700">
                      {row.categoryName}
                    </span>
                                        <span className="text-slate-500">
                      {formatCurrency(row.monthlySip)} ·{" "}
                                            {formatPercent(row.sipPercentage)}
                    </span>
                                    </div>
                                    <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                                        <div
                                            className="h-full rounded-full bg-slate-900"
                                            style={{
                                                width: `${Math.min(row.sipPercentage, 100)}%`,
                                            }}
                                        />
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="rounded-xl border border-slate-200 bg-white p-5">
                        <h2 className="text-lg font-semibold text-slate-950">
                            Current plan note
                        </h2>

                        {latestNote ? (
                            <div className="mt-4">
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <h3 className="font-medium text-slate-950">
                                            {latestNote.title}
                                        </h3>
                                        <p className="mt-1 text-xs text-slate-500">
                                            Updated {formatDate(latestNote.updated_at)}
                                        </p>
                                    </div>

                                    {latestNote.is_current && (
                                        <span
                                            className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 ring-1 ring-blue-200">
                      Current
                    </span>
                                    )}
                                </div>

                                <p className="mt-4 whitespace-pre-line text-sm leading-6 text-slate-700">
                                    {latestNote.content.slice(0, 600)}
                                    {latestNote.content.length > 600 ? "..." : ""}
                                </p>
                            </div>
                        ) : (
                            <p className="mt-4 text-sm text-slate-500">
                                No investment plan note yet.
                            </p>
                        )}
                    </div>
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

function formatMonthLabel(value: string) {
    return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" })
        .format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
}

function Metric({ label, value, signed = false }: { label: string; value: number; signed?: boolean }) {
    const tone = signed ? (value > 0 ? "text-emerald-700" : value < 0 ? "text-red-700" : "text-slate-950") : "text-slate-950";
    return <div className="rounded-lg bg-slate-50 p-4"><p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p><p className={`mt-2 text-xl font-bold ${tone}`}>{formatCurrency(value)}</p></div>;
}
