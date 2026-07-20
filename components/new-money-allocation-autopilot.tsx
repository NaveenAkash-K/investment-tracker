"use client";

import { useMemo, useState } from "react";
import {
    calculateNewMoneyAllocation,
    type NewMoneyAllocationInput,
} from "@/lib/performance";

function money(value: number) {
    return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0,
    }).format(value);
}

function percent(value: number) {
    return `${value.toFixed(2)}%`;
}

function signedPercent(value: number) {
    return `${value > 0 ? "+" : ""}${value.toFixed(2)} pp`;
}

export function NewMoneyAllocationAutopilot({
    rows,
    defaultBudget,
}: {
    rows: NewMoneyAllocationInput[];
    defaultBudget: number;
}) {
    const [budget, setBudget] = useState(defaultBudget);
    const result = useMemo(() => {
        try {
            return { allocation: calculateNewMoneyAllocation(rows, budget), error: null };
        } catch (error) {
            return {
                allocation: null,
                error: error instanceof Error ? error.message : "Allocation could not be calculated.",
            };
        }
    }, [budget, rows]);

    const plannedTotal = rows.reduce((sum, row) => sum + (row.plannedAmount ?? 0), 0);
    const suggestionTotal = result.allocation?.rows.reduce(
        (sum, row) => sum + row.suggestedAmount,
        0
    ) ?? 0;

    return (
        <section className="mt-6 overflow-hidden rounded-xl border border-blue-200 bg-white">
            <div className="flex flex-col gap-4 border-b border-blue-100 bg-blue-50 px-5 py-5 lg:flex-row lg:items-end lg:justify-between">
                <div className="max-w-3xl">
                    <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">Planning tool</p>
                    <h2 className="mt-1 text-lg font-semibold text-slate-950">New-money allocation autopilot</h2>
                    <p className="mt-1 text-sm leading-6 text-slate-600">
                        Enter the amount available to invest. The autopilot sends new money toward the categories
                        that will remain below target, without selling existing investments.
                    </p>
                </div>
                <label className="block w-full text-sm font-medium text-slate-700 sm:w-64">
                    Amount available
                    <div className="relative mt-1">
                        <span className="pointer-events-none absolute left-3 top-2.5 text-slate-400">₹</span>
                        <input
                            type="number"
                            min="0"
                            step="100"
                            value={Number.isFinite(budget) ? budget : 0}
                            onChange={(event) => setBudget(Math.max(Number(event.target.value) || 0, 0))}
                            className="w-full rounded-lg border border-blue-200 bg-white py-2 pl-7 pr-3 text-right outline-none focus:ring-2 focus:ring-blue-300"
                        />
                    </div>
                </label>
            </div>

            {result.error ? (
                <div role="alert" className="m-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                    {result.error} Save valid targets before using the autopilot.
                </div>
            ) : result.allocation ? (
                <>
                    <div className="grid gap-3 border-b border-slate-100 p-5 sm:grid-cols-3">
                        <AutopilotSummary label="Current portfolio" value={money(result.allocation.currentTotal)} />
                        <AutopilotSummary label="Current SIP plan" value={money(plannedTotal)} />
                        <AutopilotSummary label="Autopilot allocation" value={money(suggestionTotal)} />
                    </div>

                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[820px] text-left text-sm">
                            <caption className="sr-only">Target-driven allocation of the selected new-money budget</caption>
                            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                <tr>
                                    <th className="px-5 py-3">Category</th>
                                    <th className="px-5 py-3 text-right">Current / target</th>
                                    <th className="px-5 py-3 text-right">Current SIP</th>
                                    <th className="px-5 py-3 text-right">Autopilot</th>
                                    <th className="px-5 py-3 text-right">Projected %</th>
                                    <th className="px-5 py-3 text-right">Drift after</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {result.allocation.rows.map((row) => {
                                    const driftTone = Math.abs(row.projectedDriftPercentage) <= 2
                                        ? "text-emerald-700"
                                        : row.projectedDriftPercentage > 0
                                            ? "text-amber-700"
                                            : "text-red-700";

                                    return (
                                        <tr key={row.categoryId} className="text-slate-700">
                                            <td className="px-5 py-4 font-medium text-slate-950">{row.categoryName}</td>
                                            <td className="px-5 py-4 text-right tabular-nums">
                                                {percent(row.currentPercentage)} / {percent(row.targetPercentage)}
                                            </td>
                                            <td className="px-5 py-4 text-right tabular-nums">{money(row.plannedAmount ?? 0)}</td>
                                            <td className="px-5 py-4 text-right font-semibold tabular-nums text-blue-700">
                                                {money(row.suggestedAmount)}
                                            </td>
                                            <td className="px-5 py-4 text-right tabular-nums">{percent(row.projectedPercentage)}</td>
                                            <td className={`px-5 py-4 text-right font-medium tabular-nums ${driftTone}`}>
                                                {signedPercent(row.projectedDriftPercentage)}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>

                    <div className="border-t border-slate-100 px-5 py-4 text-sm leading-6 text-slate-500">
                        This is a target-correction suggestion, not a market prediction. It uses every rupee entered,
                        ignores analyser signals and fund-level limits, and does not modify SIPs or monthly-review data.
                    </div>
                </>
            ) : null}
        </section>
    );
}

function AutopilotSummary({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-lg bg-slate-50 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-1 text-lg font-semibold text-slate-950">{value}</p>
        </div>
    );
}
