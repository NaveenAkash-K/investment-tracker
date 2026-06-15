import type {
    InputHTMLAttributes,
} from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resetTargetsToDefault, updateTargets } from "./actions";
import {PageHeader} from "@/components/page-header";

type Category = {
    id: string;
    name: string;
    sort_order: number | null;
};

type Target = {
    category_id: string;
    target_percentage: number | string | null;
};

type Holding = {
    category_id: string;
    current_value_inr: number | string | null;
};

type SipPlan = {
    category_id: string;
    monthly_amount: number | string | null;
};

type TargetRow = {
    categoryId: string;
    categoryName: string;
    currentAmount: number;
    currentPercentage: number;
    targetPercentage: number;
    targetAmount: number;
    gapToTarget: number;
    monthlySip: number;
    sipPercentage: number;
    differencePercentage: number;
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

function inputNumberValue(value: unknown, decimals = 2): string {
    return toNumber(value).toFixed(decimals);
}

function getStatus(differencePercentage: number): TargetRow["status"] {
    if (differencePercentage > 2) return "Overweight";
    if (differencePercentage < -2) return "Underweight";
    return "Near target";
}

function getStatusClasses(status: TargetRow["status"]): string {
    if (status === "Overweight") {
        return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
    }

    if (status === "Underweight") {
        return "bg-red-50 text-red-700 ring-1 ring-red-200";
    }

    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
}

function buildTargetWarnings(rows: TargetRow[], totalTargetPercentage: number) {
    const warnings: string[] = [];

    if (Math.abs(totalTargetPercentage - 100) > 0.01) {
        warnings.push(
            `Saved target allocation total is ${totalTargetPercentage.toFixed(
                2
            )}%. It should be exactly 100%.`
        );
    }

    for (const row of rows) {
        if (row.differencePercentage < -2) {
            warnings.push(
                `${row.categoryName} is under target by ${formatPercent(
                    Math.abs(row.differencePercentage)
                )}. Gap to target is ${formatCurrency(row.gapToTarget)}.`
            );
        }

        if (row.differencePercentage > 2) {
            warnings.push(
                `${row.categoryName} is above target by ${formatPercent(
                    row.differencePercentage
                )}.`
            );
        }

        if (row.targetPercentage > 0 && row.monthlySip === 0) {
            warnings.push(
                `${row.categoryName} has a target of ${formatPercent(
                    row.targetPercentage
                )}, but current SIP is zero.`
            );
        }
    }

    return warnings;
}

export default async function TargetsPage() {
    const supabase = await createClient();

    const {
        data: { user },
        error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
        redirect("/auth/login");
    }

    const [categoriesResult, targetsResult, holdingsResult, sipPlansResult] =
        await Promise.all([
            supabase
                .from("asset_categories")
                .select("id, name, sort_order")
                .eq("user_id", user.id)
                .order("sort_order", { ascending: true }),

            supabase
                .from("portfolio_targets")
                .select("category_id, target_percentage")
                .eq("user_id", user.id),

            supabase
                .from("holdings")
                .select("category_id, current_value_inr")
                .eq("user_id", user.id)
                .eq("is_active", true),

            supabase
                .from("sip_plans")
                .select("category_id, monthly_amount")
                .eq("user_id", user.id)
                .eq("is_active", true),
        ]);

    const queryError =
        categoriesResult.error ||
        targetsResult.error ||
        holdingsResult.error ||
        sipPlansResult.error;

    if (queryError) {
        return (
            <main className="mx-auto max-w-6xl px-4 py-8">
                <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-red-800">
                    <h1 className="text-xl font-semibold">Targets error</h1>
                    <p className="mt-2 text-sm">{queryError.message}</p>
                </div>
            </main>
        );
    }

    const categories = (categoriesResult.data ?? []) as Category[];
    const targets = (targetsResult.data ?? []) as Target[];
    const holdings = (holdingsResult.data ?? []) as Holding[];
    const sipPlans = (sipPlansResult.data ?? []) as SipPlan[];

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
        const currentAmount = amountByCategoryId.get(holding.category_id) ?? 0;

        amountByCategoryId.set(
            holding.category_id,
            currentAmount + toNumber(holding.current_value_inr)
        );
    }

    for (const sipPlan of sipPlans) {
        const currentSip = sipByCategoryId.get(sipPlan.category_id) ?? 0;

        sipByCategoryId.set(
            sipPlan.category_id,
            currentSip + toNumber(sipPlan.monthly_amount)
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

    const rows: TargetRow[] = categories.map((category) => {
        const currentAmount = amountByCategoryId.get(category.id) ?? 0;
        const monthlySip = sipByCategoryId.get(category.id) ?? 0;
        const targetPercentage = targetByCategoryId.get(category.id) ?? 0;

        const currentPercentage =
            totalPortfolioValue > 0
                ? (currentAmount / totalPortfolioValue) * 100
                : 0;

        const sipPercentage =
            totalMonthlySip > 0 ? (monthlySip / totalMonthlySip) * 100 : 0;

        const targetAmount = (totalPortfolioValue * targetPercentage) / 100;
        const gapToTarget = targetAmount - currentAmount;
        const differencePercentage = currentPercentage - targetPercentage;

        return {
            categoryId: category.id,
            categoryName: category.name,
            currentAmount,
            currentPercentage,
            targetPercentage,
            targetAmount,
            gapToTarget,
            monthlySip,
            sipPercentage,
            differencePercentage,
            status: getStatus(differencePercentage),
        };
    });

    const totalTargetPercentage = rows.reduce(
        (sum, row) => sum + row.targetPercentage,
        0
    );

    const warnings = buildTargetWarnings(rows, totalTargetPercentage);

    return (
        <main className="min-h-screen bg-slate-50">
            <div className="mx-auto max-w-7xl px-4 py-8">
                <PageHeader
                    title="Targets"
                    description="Set your portfolio target allocation and compare it with current allocation and SIP allocation."
                />

                <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <SummaryCard
                        label="Target total"
                        value={formatPercent(totalTargetPercentage)}
                        helper={
                            Math.abs(totalTargetPercentage - 100) <= 0.01
                                ? "Valid allocation"
                                : "Must equal 100%"
                        }
                    />
                    <SummaryCard
                        label="Portfolio value"
                        value={formatCurrency(totalPortfolioValue)}
                        helper="Used for target amount"
                    />
                    <SummaryCard
                        label="Monthly SIP"
                        value={formatCurrency(totalMonthlySip)}
                        helper="Used for SIP comparison"
                    />
                    <SummaryCard
                        label="Categories"
                        value={String(categories.length)}
                        helper="Asset allocation groups"
                    />
                </section>

                {warnings.length > 0 && (
                    <section className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5">
                        <h2 className="text-base font-semibold text-amber-900">
                            Target allocation warnings
                        </h2>
                        <ul className="mt-3 space-y-2 text-sm text-amber-800">
                            {warnings.slice(0, 6).map((warning) => (
                                <li key={warning}>• {warning}</li>
                            ))}
                        </ul>
                    </section>
                )}

                <section className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
                    <div className="flex flex-col gap-4 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                            <h2 className="text-lg font-semibold text-slate-950">
                                Edit target allocation
                            </h2>
                            <p className="mt-1 text-sm text-slate-500">
                                Example: Indian Assets 60%, US Assets 15%, Debt 10%, Gold &
                                Silver 10%, Crypto 5%.
                            </p>
                        </div>

                        <form action={resetTargetsToDefault}>
                            <button
                                type="submit"
                                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                            >
                                Reset to default
                            </button>
                        </form>
                    </div>

                    <form action={updateTargets}>
                        <div className="overflow-x-auto">
                            <table className="w-full min-w-[1000px] text-left text-sm">
                                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                <tr>
                                    <th className="px-5 py-3">Category</th>
                                    <th className="px-5 py-3 text-right">Target %</th>
                                    <th className="px-5 py-3 text-right">Current %</th>
                                    <th className="px-5 py-3 text-right">Difference</th>
                                    <th className="px-5 py-3 text-right">Current amount</th>
                                    <th className="px-5 py-3 text-right">Target amount</th>
                                    <th className="px-5 py-3 text-right">Gap to target</th>
                                    <th className="px-5 py-3 text-right">SIP %</th>
                                    <th className="px-5 py-3">Status</th>
                                </tr>
                                </thead>

                                <tbody className="divide-y divide-slate-100">
                                {rows.map((row) => (
                                    <tr key={row.categoryId} className="text-slate-700">
                                        <td className="px-5 py-4 font-medium text-slate-950">
                                            <input
                                                type="hidden"
                                                name="category_id"
                                                value={row.categoryId}
                                            />
                                            {row.categoryName}
                                        </td>

                                        <td className="px-5 py-4">
                                            <Input
                                                name={`target_percentage_${row.categoryId}`}
                                                type="number"
                                                min="0"
                                                max="100"
                                                step="0.01"
                                                defaultValue={inputNumberValue(
                                                    row.targetPercentage,
                                                    2
                                                )}
                                                className="ml-auto max-w-32 text-right"
                                                required
                                            />
                                        </td>

                                        <td className="px-5 py-4 text-right">
                                            {formatPercent(row.currentPercentage)}
                                        </td>

                                        <td className="px-5 py-4 text-right">
                                            {formatPercent(row.differencePercentage)}
                                        </td>

                                        <td className="px-5 py-4 text-right">
                                            {formatCurrency(row.currentAmount)}
                                        </td>

                                        <td className="px-5 py-4 text-right">
                                            {formatCurrency(row.targetAmount)}
                                        </td>

                                        <td className="px-5 py-4 text-right">
                                            {formatCurrency(row.gapToTarget)}
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

                                <tr className="bg-slate-50 font-semibold text-slate-950">
                                    <td className="px-5 py-4">Total</td>
                                    <td className="px-5 py-4 text-right">
                                        {formatPercent(totalTargetPercentage)}
                                    </td>
                                    <td className="px-5 py-4 text-right">
                                        {totalPortfolioValue > 0 ? "100.00%" : "0.00%"}
                                    </td>
                                    <td className="px-5 py-4 text-right">-</td>
                                    <td className="px-5 py-4 text-right">
                                        {formatCurrency(totalPortfolioValue)}
                                    </td>
                                    <td className="px-5 py-4 text-right">
                                        {formatCurrency(totalPortfolioValue)}
                                    </td>
                                    <td className="px-5 py-4 text-right">-</td>
                                    <td className="px-5 py-4 text-right">
                                        {totalMonthlySip > 0 ? "100.00%" : "0.00%"}
                                    </td>
                                    <td className="px-5 py-4">
                                        {Math.abs(totalTargetPercentage - 100) <= 0.01 ? (
                                            <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
                          Valid
                        </span>
                                        ) : (
                                            <span className="inline-flex rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700 ring-1 ring-red-200">
                          Invalid
                        </span>
                                        )}
                                    </td>
                                </tr>
                                </tbody>
                            </table>
                        </div>

                        <div className="flex flex-col gap-3 border-t border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                            <p className="text-sm text-slate-500">
                                Saving will fail if the target total is not 100%.
                            </p>

                            <button
                                type="submit"
                                className="rounded-lg bg-slate-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
                            >
                                Save targets
                            </button>
                        </div>
                    </form>
                </section>

                <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
                    <h2 className="text-lg font-semibold text-slate-950">
                        How to read this page
                    </h2>

                    <div className="mt-4 grid gap-4 md:grid-cols-3">
                        <InfoBox
                            title="Current %"
                            text="Your actual portfolio allocation based on active holdings."
                        />
                        <InfoBox
                            title="Gap to target"
                            text="Positive means underweight. Negative means overweight."
                        />
                        <InfoBox
                            title="SIP %"
                            text="Your monthly SIP allocation by category, useful for checking future drift."
                        />
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

function InfoBox({ title, text }: { title: string; text: string }) {
    return (
        <div className="rounded-lg bg-slate-50 p-4">
            <h3 className="text-sm font-semibold text-slate-950">{title}</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">{text}</p>
        </div>
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