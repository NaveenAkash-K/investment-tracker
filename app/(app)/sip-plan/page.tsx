import type {
    InputHTMLAttributes,
    ReactNode,
    SelectHTMLAttributes,
} from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
    addSipPlan,
    archiveSipPlan,
    bulkUpdateSipAmounts,
    updateSipPlan,
} from "./actions";
import {PageHeader} from "@/components/page-header";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";

type Category = {
    id: string;
    name: string;
    sort_order: number | null;
};

type SipPlan = {
    id: string;
    category_id: string;
    name: string;
    monthly_amount: number | string | null;
    sip_day: number | null;
    is_active: boolean | null;
    notes: string | null;
    created_at: string | null;
    updated_at: string | null;
};

type Target = {
    category_id: string;
    target_percentage: number | string | null;
};

type Holding = {
    category_id: string;
    current_value_inr: number | string | null;
};

type SipSummaryRow = {
    categoryId: string;
    categoryName: string;
    monthlySip: number;
    sipPercentage: number;
    targetPercentage: number;
    sipVsTargetDifference: number;
    currentPortfolioAmount: number;
    currentPortfolioPercentage: number;
    projectedPortfolioPercentage: number;
    status: "Corrective" | "Neutral" | "Adds drift";
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

function formatCurrencyWithDecimals(value: number): string {
    return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 2,
    }).format(value);
}

function formatPercent(value: number): string {
    return `${value.toFixed(2)}%`;
}

function inputNumberValue(value: unknown, decimals = 2): string {
    return toNumber(value).toFixed(decimals);
}

function getStatus(currentDifference: number, projectedDifference: number): SipSummaryRow["status"] {
    if (Math.abs(projectedDifference) < Math.abs(currentDifference) - 0.1) return "Corrective";
    if (Math.abs(projectedDifference) > Math.abs(currentDifference) + 0.1) return "Adds drift";
    return "Neutral";
}

function getStatusClasses(status: SipSummaryRow["status"]): string {
    if (status === "Adds drift") {
        return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
    }

    if (status === "Neutral") {
        return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
    }

    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
}

function buildSipWarnings(rows: SipSummaryRow[]): string[] {
    const warnings: string[] = [];

    for (const row of rows) {
        if (row.currentPortfolioPercentage < row.targetPercentage - 2 && row.monthlySip === 0) {
            warnings.push(
                `${row.categoryName} is underweight, but its planned SIP is zero.`
            );
        }

        if (row.status === "Adds drift") {
            warnings.push(
                `${row.categoryName}'s planned SIP moves the portfolio farther from its target based on the current values.`
            );
        }
    }

    return warnings;
}

export default async function SipPlanPage() {
    const supabase = await createClient();

    const {
        data: { user },
        error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
        redirect("/auth/login");
    }

    const [categoriesResult, sipPlansResult, targetsResult, holdingsResult] =
        await Promise.all([
            supabase
                .from("asset_categories")
                .select("id, name, sort_order")
                .eq("user_id", user.id)
                .order("sort_order", { ascending: true }),

            supabase
                .from("sip_plans")
                .select(
                    "id, category_id, name, monthly_amount, sip_day, is_active, notes, created_at, updated_at"
                )
                .eq("user_id", user.id)
                .eq("is_active", true)
                .order("name", { ascending: true }),

            supabase
                .from("portfolio_targets")
                .select("category_id, target_percentage")
                .eq("user_id", user.id),

            supabase
                .from("holdings")
                .select("category_id, current_value_inr")
                .eq("user_id", user.id)
                .eq("is_active", true),
        ]);

    const queryError =
        categoriesResult.error ||
        sipPlansResult.error ||
        targetsResult.error ||
        holdingsResult.error;

    if (queryError) {
        return (
            <main className="mx-auto max-w-6xl px-4 py-8">
                <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-red-800">
                    <h1 className="text-xl font-semibold">SIP plan error</h1>
                    <p className="mt-2 text-sm">{queryError.message}</p>
                </div>
            </main>
        );
    }

    const categories = (categoriesResult.data ?? []) as Category[];
    const sipPlans = (sipPlansResult.data ?? []) as SipPlan[];
    const targets = (targetsResult.data ?? []) as Target[];
    const holdings = (holdingsResult.data ?? []) as Holding[];

    const categoryById = new Map(
        categories.map((category) => [category.id, category])
    );

    const targetByCategoryId = new Map<string, number>();
    const sipByCategoryId = new Map<string, number>();
    const portfolioAmountByCategoryId = new Map<string, number>();

    for (const target of targets) {
        targetByCategoryId.set(
            target.category_id,
            toNumber(target.target_percentage)
        );
    }

    for (const sipPlan of sipPlans) {
        const currentAmount = sipByCategoryId.get(sipPlan.category_id) ?? 0;
        sipByCategoryId.set(
            sipPlan.category_id,
            currentAmount + toNumber(sipPlan.monthly_amount)
        );
    }

    for (const holding of holdings) {
        const currentAmount =
            portfolioAmountByCategoryId.get(holding.category_id) ?? 0;

        portfolioAmountByCategoryId.set(
            holding.category_id,
            currentAmount + toNumber(holding.current_value_inr)
        );
    }

    const totalMonthlySip = sipPlans.reduce(
        (sum, sipPlan) => sum + toNumber(sipPlan.monthly_amount),
        0
    );

    const totalPortfolioValue = holdings.reduce(
        (sum, holding) => sum + toNumber(holding.current_value_inr),
        0
    );

    const summaryRows: SipSummaryRow[] = categories.map((category) => {
        const monthlySip = sipByCategoryId.get(category.id) ?? 0;
        const targetPercentage = targetByCategoryId.get(category.id) ?? 0;
        const currentPortfolioAmount =
            portfolioAmountByCategoryId.get(category.id) ?? 0;

        const sipPercentage =
            totalMonthlySip > 0 ? (monthlySip / totalMonthlySip) * 100 : 0;

        const currentPortfolioPercentage =
            totalPortfolioValue > 0
                ? (currentPortfolioAmount / totalPortfolioValue) * 100
                : 0;

        const sipVsTargetDifference = sipPercentage - targetPercentage;
        const projectedPortfolioPercentage = totalPortfolioValue + totalMonthlySip > 0
            ? ((currentPortfolioAmount + monthlySip) / (totalPortfolioValue + totalMonthlySip)) * 100
            : 0;
        const currentDifference = currentPortfolioPercentage - targetPercentage;
        const projectedDifference = projectedPortfolioPercentage - targetPercentage;

        return {
            categoryId: category.id,
            categoryName: category.name,
            monthlySip,
            sipPercentage,
            targetPercentage,
            sipVsTargetDifference,
            currentPortfolioAmount,
            currentPortfolioPercentage,
            projectedPortfolioPercentage,
            status: getStatus(currentDifference, projectedDifference),
        };
    });

    const warnings = buildSipWarnings(summaryRows);

    const highestSipRow = [...summaryRows].sort(
        (a, b) => b.monthlySip - a.monthlySip
    )[0];

    const zeroSipCategories = summaryRows.filter(
        (row) => row.targetPercentage > 0 && row.monthlySip === 0
    );

    return (
        <main className="min-h-screen bg-slate-50">
            <div className="mx-auto max-w-7xl px-4 py-8">
                <PageHeader
                    title="SIP Plan"
                    description="Track planned monthly investments and see whether they correct current portfolio drift."
                />

                <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <SummaryCard
                        label="Total monthly SIP"
                        value={formatCurrency(totalMonthlySip)}
                        helper={`${sipPlans.length} active SIPs`}
                    />
                    <SummaryCard
                        label="Highest SIP category"
                        value={highestSipRow?.categoryName ?? "None"}
                        helper={
                            highestSipRow
                                ? formatCurrency(highestSipRow.monthlySip)
                                : "No SIPs yet"
                        }
                    />
                    <SummaryCard
                        label="Categories without SIP"
                        value={String(zeroSipCategories.length)}
                        helper="Target categories with zero SIP"
                    />
                    <SummaryCard
                        label="Current portfolio"
                        value={formatCurrency(totalPortfolioValue)}
                        helper="Used for portfolio % comparison"
                    />
                </section>

                {warnings.length > 0 && (
                    <section className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5">
                        <h2 className="text-base font-semibold text-amber-900">
                            SIP alignment warnings
                        </h2>
                        <ul className="mt-3 space-y-2 text-sm text-amber-800">
                            {warnings.slice(0, 6).map((warning) => (
                                <li key={warning}>• {warning}</li>
                            ))}
                        </ul>
                    </section>
                )}

                <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
                    <div className="mb-5">
                        <h2 className="text-lg font-semibold text-slate-950">
                            Add new SIP
                        </h2>
                        <p className="mt-1 text-sm text-slate-500">
                            Add each active SIP or monthly allocation. For US stocks and
                            crypto, enter the INR monthly amount you plan to invest.
                        </p>
                    </div>

                    <form action={addSipPlan} className="grid gap-4 lg:grid-cols-12">
                        <div className="lg:col-span-4">
                            <Label htmlFor="name">SIP name</Label>
                            <Input
                                id="name"
                                name="name"
                                placeholder="Parag Parikh Flexi Cap Fund"
                                required
                            />
                        </div>

                        <div className="lg:col-span-2">
                            <Label htmlFor="category_id">Category</Label>
                            <Select id="category_id" name="category_id" required>
                                <option value="">Select category</option>
                                {categories.map((category) => (
                                    <option key={category.id} value={category.id}>
                                        {category.name}
                                    </option>
                                ))}
                            </Select>
                        </div>

                        <div className="lg:col-span-2">
                            <Label htmlFor="monthly_amount">Monthly amount</Label>
                            <Input
                                id="monthly_amount"
                                name="monthly_amount"
                                type="number"
                                min="0"
                                step="0.01"
                                placeholder="6500"
                                required
                            />
                        </div>

                        <div className="lg:col-span-2">
                            <Label htmlFor="sip_day">SIP day</Label>
                            <Input
                                id="sip_day"
                                name="sip_day"
                                type="number"
                                min="1"
                                max="31"
                                step="1"
                                placeholder="Optional"
                            />
                        </div>

                        <div className="lg:col-span-2">
                            <Label htmlFor="notes">Notes</Label>
                            <Input id="notes" name="notes" placeholder="Optional" />
                        </div>

                        <div className="flex items-end lg:col-span-12">
                            <button
                                type="submit"
                                className="rounded-lg bg-slate-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
                            >
                                Add SIP
                            </button>
                        </div>
                    </form>
                </section>

                <section className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
                    <div className="border-b border-slate-200 px-5 py-4">
                        <h2 className="text-lg font-semibold text-slate-950">
                            SIP allocation summary
                        </h2>
                        <p className="mt-1 text-sm text-slate-500">
                            Shows the planned split and whether one month of it moves the current
                            portfolio closer to its targets.
                        </p>
                    </div>

                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[900px] text-left text-sm">
                            <caption className="sr-only">Planned SIP allocation and its effect on current portfolio drift</caption>
                            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                            <tr>
                                <th className="px-5 py-3">Category</th>
                                <th className="px-5 py-3 text-right">Monthly SIP</th>
                                <th className="px-5 py-3 text-right">SIP %</th>
                                <th className="px-5 py-3 text-right">Target %</th>
                                <th className="px-5 py-3 text-right">Current portfolio %</th>
                                <th className="px-5 py-3 text-right">After planned SIP</th>
                                <th className="px-5 py-3">Status</th>
                            </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                            {summaryRows.map((row) => (
                                <tr key={row.categoryId} className="text-slate-700">
                                    <td className="px-5 py-4 font-medium text-slate-950">
                                        {row.categoryName}
                                    </td>
                                    <td className="px-5 py-4 text-right">
                                        {formatCurrency(row.monthlySip)}
                                    </td>
                                    <td className="px-5 py-4 text-right">
                                        {formatPercent(row.sipPercentage)}
                                    </td>
                                    <td className="px-5 py-4 text-right">
                                        {formatPercent(row.targetPercentage)}
                                    </td>
                                    <td className="px-5 py-4 text-right">
                                        {formatPercent(row.currentPortfolioPercentage)}
                                    </td>
                                    <td className="px-5 py-4 text-right">
                                        {formatPercent(row.projectedPortfolioPercentage)}
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

                            {summaryRows.length === 0 && (
                                <tr>
                                    <td
                                        colSpan={7}
                                        className="px-5 py-10 text-center text-slate-500"
                                    >
                                        No asset categories found.
                                    </td>
                                </tr>
                            )}
                            </tbody>
                        </table>
                    </div>
                </section>

                <section className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
                    <div className="border-b border-slate-200 px-5 py-4">
                        <h2 className="text-lg font-semibold text-slate-950">
                            Quick monthly SIP update
                        </h2>
                        <p className="mt-1 text-sm text-slate-500">
                            Use this when you only want to update SIP amounts or SIP dates.
                        </p>
                    </div>

                    {sipPlans.length > 0 ? (
                        <form action={bulkUpdateSipAmounts}>
                            <div className="overflow-x-auto">
                                <table className="w-full min-w-[750px] text-left text-sm">
                                    <caption className="sr-only">Quick monthly SIP amount and date update</caption>
                                    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                    <tr>
                                        <th className="px-5 py-3">SIP</th>
                                        <th className="px-5 py-3">Category</th>
                                        <th className="px-5 py-3 text-right">Monthly amount</th>
                                        <th className="px-5 py-3 text-right">SIP day</th>
                                    </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-100">
                                    {sipPlans.map((sipPlan) => (
                                        <tr key={sipPlan.id}>
                                            <td className="px-5 py-4">
                                                <input
                                                    type="hidden"
                                                    name="sip_plan_id"
                                                    value={sipPlan.id}
                                                />
                                                <div className="font-medium text-slate-950">
                                                    {sipPlan.name}
                                                </div>
                                                {sipPlan.notes && (
                                                    <div className="mt-1 text-xs text-slate-500">
                                                        {sipPlan.notes}
                                                    </div>
                                                )}
                                            </td>
                                            <td className="px-5 py-4 text-slate-600">
                                                {categoryById.get(sipPlan.category_id)?.name ||
                                                    "Unknown"}
                                            </td>
                                            <td className="px-5 py-4">
                                                <Input
                                                    name={`monthly_amount_${sipPlan.id}`}
                                                    type="number"
                                                    min="0"
                                                    step="0.01"
                                                    defaultValue={inputNumberValue(
                                                        sipPlan.monthly_amount,
                                                        2
                                                    )}
                                                    className="ml-auto max-w-40 text-right"
                                                    required
                                                />
                                            </td>
                                            <td className="px-5 py-4">
                                                <Input
                                                    name={`sip_day_${sipPlan.id}`}
                                                    type="number"
                                                    min="1"
                                                    max="31"
                                                    step="1"
                                                    defaultValue={sipPlan.sip_day ?? ""}
                                                    placeholder="-"
                                                    className="ml-auto max-w-28 text-right"
                                                />
                                            </td>
                                        </tr>
                                    ))}
                                    </tbody>
                                </table>
                            </div>

                            <div className="flex justify-end border-t border-slate-200 px-5 py-4">
                                <button
                                    type="submit"
                                    className="rounded-lg bg-slate-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
                                >
                                    Save SIP updates
                                </button>
                            </div>
                        </form>
                    ) : (
                        <div className="px-5 py-10 text-center text-sm text-slate-500">
                            No SIPs yet. Add your first SIP above.
                        </div>
                    )}
                </section>

                <section className="mt-6">
                    <div className="mb-4">
                        <h2 className="text-lg font-semibold text-slate-950">
                            Detailed SIPs
                        </h2>
                        <p className="mt-1 text-sm text-slate-500">
                            Edit details or archive SIPs that are no longer active.
                        </p>
                    </div>

                    {sipPlans.length > 0 ? (
                        <div className="grid gap-4 lg:grid-cols-2">
                            {sipPlans.map((sipPlan) => (
                                <article
                                    key={sipPlan.id}
                                    className="rounded-xl border border-slate-200 bg-white p-5"
                                >
                                    <div className="flex items-start justify-between gap-4">
                                        <div>
                                            <h3 className="font-semibold text-slate-950">
                                                {sipPlan.name}
                                            </h3>
                                            <p className="mt-1 text-sm text-slate-500">
                                                {categoryById.get(sipPlan.category_id)?.name ||
                                                    "Unknown"}
                                                {sipPlan.sip_day
                                                    ? ` · SIP day ${sipPlan.sip_day}`
                                                    : " · No fixed SIP day"}
                                            </p>
                                        </div>

                                        <div className="text-right">
                                            <p className="font-semibold text-slate-950">
                                                {formatCurrencyWithDecimals(
                                                    toNumber(sipPlan.monthly_amount)
                                                )}
                                            </p>
                                            <p className="mt-1 text-xs text-slate-500">per month</p>
                                        </div>
                                    </div>

                                    {sipPlan.notes && (
                                        <p className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
                                            {sipPlan.notes}
                                        </p>
                                    )}

                                    <details className="mt-4 rounded-lg border border-slate-200">
                                        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-slate-700">
                                            Edit SIP
                                        </summary>

                                        <form
                                            action={updateSipPlan}
                                            className="grid gap-4 border-t border-slate-200 p-4 sm:grid-cols-2"
                                        >
                                            <input
                                                type="hidden"
                                                name="sip_plan_id"
                                                value={sipPlan.id}
                                            />

                                            <div className="sm:col-span-2">
                                                <Label htmlFor={`name_${sipPlan.id}`}>SIP name</Label>
                                                <Input
                                                    id={`name_${sipPlan.id}`}
                                                    name="name"
                                                    defaultValue={sipPlan.name}
                                                    required
                                                />
                                            </div>

                                            <div>
                                                <Label htmlFor={`category_${sipPlan.id}`}>
                                                    Category
                                                </Label>
                                                <Select
                                                    id={`category_${sipPlan.id}`}
                                                    name="category_id"
                                                    defaultValue={sipPlan.category_id}
                                                    required
                                                >
                                                    {categories.map((category) => (
                                                        <option key={category.id} value={category.id}>
                                                            {category.name}
                                                        </option>
                                                    ))}
                                                </Select>
                                            </div>

                                            <div>
                                                <Label htmlFor={`monthly_amount_${sipPlan.id}`}>
                                                    Monthly amount
                                                </Label>
                                                <Input
                                                    id={`monthly_amount_${sipPlan.id}`}
                                                    name="monthly_amount"
                                                    type="number"
                                                    min="0"
                                                    step="0.01"
                                                    defaultValue={inputNumberValue(
                                                        sipPlan.monthly_amount,
                                                        2
                                                    )}
                                                    required
                                                />
                                            </div>

                                            <div>
                                                <Label htmlFor={`sip_day_${sipPlan.id}`}>SIP day</Label>
                                                <Input
                                                    id={`sip_day_${sipPlan.id}`}
                                                    name="sip_day"
                                                    type="number"
                                                    min="1"
                                                    max="31"
                                                    step="1"
                                                    defaultValue={sipPlan.sip_day ?? ""}
                                                    placeholder="Optional"
                                                />
                                            </div>

                                            <div className="sm:col-span-2">
                                                <Label htmlFor={`notes_${sipPlan.id}`}>Notes</Label>
                                                <textarea
                                                    id={`notes_${sipPlan.id}`}
                                                    name="notes"
                                                    defaultValue={sipPlan.notes || ""}
                                                    rows={3}
                                                    className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950 outline-none ring-slate-300 focus:ring-2"
                                                />
                                            </div>

                                            <div className="sm:col-span-2">
                                                <button
                                                    type="submit"
                                                    className="rounded-lg bg-slate-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
                                                >
                                                    Save changes
                                                </button>
                                            </div>
                                        </form>
                                    </details>

                                    <form action={archiveSipPlan} className="mt-3">
                                        <input
                                            type="hidden"
                                            name="sip_plan_id"
                                            value={sipPlan.id}
                                        />
                                        <ConfirmSubmitButton confirmation={`Archive ${sipPlan.name}? You can restore it from Archive.`} pendingLabel="Archiving…" className="text-sm font-medium text-red-600 hover:text-red-700 disabled:opacity-50">Archive SIP</ConfirmSubmitButton>
                                    </form>
                                </article>
                            ))}
                        </div>
                    ) : (
                        <div className="rounded-xl border border-slate-200 bg-white px-5 py-10 text-center text-sm text-slate-500">
                            No SIPs to show yet.
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

function Select({
                    className = "",
                    children,
                    ...props
                }: SelectHTMLAttributes<HTMLSelectElement>) {
    return (
        <select
            {...props}
            className={`mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950 outline-none ring-slate-300 focus:ring-2 ${className}`}
        >
            {children}
        </select>
    );
}
