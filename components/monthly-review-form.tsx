"use client";

import { useMemo, useState } from "react";
import { FormSubmitButton } from "@/components/form-submit-button";
import type { TrackingCurrency } from "@/lib/performance";

export type MonthlyReviewFormRow = {
    categoryId: string;
    categoryName: string;
    currency: TrackingCurrency;
    closingNativeValue: number;
    closingFxRate: number;
    plannedSip: number;
    suggestedSip: number | null;
    previousNativeValue: number | null;
    previousFxRate: number | null;
    savedContributionInr: number;
    savedContributionNative: number;
    savedContributionFxRate: number;
    savedClosingFxRate: number;
    isBaseline: boolean;
};

function numberValue(value: number, decimals = 2) {
    return Number.isFinite(value) ? value.toFixed(decimals) : "0.00";
}

function MonthlyRow({ row }: { row: MonthlyReviewFormRow }) {
    const [contributionInr, setContributionInr] = useState(row.savedContributionInr);
    const [conversionRate, setConversionRate] = useState(
        row.currency === "INR" ? 1 : row.savedContributionFxRate || row.closingFxRate
    );
    const [foreignContribution, setForeignContribution] = useState(
        row.savedContributionNative ||
            (contributionInr > 0 && conversionRate > 0 ? contributionInr / conversionRate : 0)
    );
    const [closingFx, setClosingFx] = useState(
        row.currency === "INR" ? 1 : row.savedClosingFxRate || row.closingFxRate
    );
    const [closingNativeValue, setClosingNativeValue] = useState(row.closingNativeValue);

    const updateContribution = (value: number) => {
        setContributionInr(value);
        if (row.currency === "USD" && conversionRate > 0) setForeignContribution(value / conversionRate);
    };
    const updateConversionRate = (value: number) => {
        setConversionRate(value);
        if (row.currency === "USD" && value > 0) setForeignContribution(contributionInr / value);
    };

    const closingInr = closingNativeValue * closingFx;

    return (
        <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <input type="hidden" name="category_id" value={row.categoryId} />

            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <div className="flex items-center gap-2">
                        <h2 className="font-semibold text-slate-950">{row.categoryName}</h2>
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">{row.currency}</span>
                        {row.isBaseline && <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">Baseline</span>}
                    </div>
                    <p className="mt-1 text-sm text-slate-500">
                        Prefilled from active holdings; adjust the category close if needed.
                    </p>
                </div>
                <div className="text-right">
                    <p className="text-xs uppercase tracking-wide text-slate-400">Current INR value</p>
                    <p className="mt-1 font-semibold text-slate-950">₹{numberValue(closingInr)}</p>
                </div>
            </div>

            <div className={`mt-5 grid gap-4 ${row.currency === "USD" ? "sm:grid-cols-2 xl:grid-cols-5" : "sm:grid-cols-2"}`}>
                <label className="block text-sm font-medium text-slate-700">
                    Actual amount invested this month
                    <div className="relative mt-1">
                        <span className="pointer-events-none absolute left-3 top-2.5 text-slate-400">₹</span>
                        <input
                            name={`contribution_inr_${row.categoryId}`}
                            type="number"
                            min="0"
                            step="0.01"
                            value={contributionInr}
                            onChange={(event) => updateContribution(Number(event.target.value))}
                            className="w-full rounded-lg border border-slate-200 py-2 pl-7 pr-3 outline-none focus:ring-2 focus:ring-slate-300"
                        />
                    </div>
                    <span className="mt-1 block text-xs font-normal text-slate-400">
                        Planned SIP: ₹{numberValue(row.plannedSip, 0)}{row.suggestedSip === null ? "" : ` · Latest analyser suggestion: ₹${numberValue(row.suggestedSip, 0)}`}. Enter the actual amount.
                    </span>
                </label>

                <label className="block text-sm font-medium text-slate-700">
                    Closing category value ({row.currency})
                    <input
                        name={`closing_native_value_${row.categoryId}`}
                        type="number"
                        min="0"
                        step={row.currency === "USD" ? "0.000001" : "0.01"}
                        value={closingNativeValue}
                        onChange={(event) => setClosingNativeValue(Number(event.target.value))}
                        className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 outline-none focus:ring-2 focus:ring-slate-300"
                    />
                    <span className="mt-1 block text-xs font-normal text-slate-400">Total closing value for this category, not the amount invested.</span>
                </label>

                {row.currency === "USD" ? (
                    <>
                        <label className="block text-sm font-medium text-slate-700">
                            Conversion rate (USD/INR)
                            <input
                                name={`contribution_fx_rate_${row.categoryId}`}
                                type="number"
                                min="0.000001"
                                step="0.000001"
                                value={conversionRate}
                                onChange={(event) => updateConversionRate(Number(event.target.value))}
                                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 outline-none focus:ring-2 focus:ring-slate-300"
                            />
                        </label>
                        <label className="block text-sm font-medium text-slate-700">
                            USD received
                            <div className="relative mt-1">
                                <span className="pointer-events-none absolute left-3 top-2.5 text-slate-400">$</span>
                                <input
                                    name={`contribution_native_${row.categoryId}`}
                                    type="number"
                                    min="0"
                                    step="0.000001"
                                    value={foreignContribution}
                                    onChange={(event) => setForeignContribution(Number(event.target.value))}
                                    className="w-full rounded-lg border border-slate-200 py-2 pl-7 pr-3 outline-none focus:ring-2 focus:ring-slate-300"
                                />
                            </div>
                            <span className="mt-1 block text-xs font-normal text-slate-400">Calculated automatically; adjust if your credited amount differs.</span>
                        </label>
                        <label className="block text-sm font-medium text-slate-700">
                            Closing USD/INR rate
                            <input
                                name={`closing_fx_rate_${row.categoryId}`}
                                type="number"
                                min="0.000001"
                                step="0.000001"
                                value={closingFx}
                                onChange={(event) => setClosingFx(Number(event.target.value))}
                                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 outline-none focus:ring-2 focus:ring-slate-300"
                            />
                        </label>
                    </>
                ) : (
                    <>
                        <input type="hidden" name={`contribution_native_${row.categoryId}`} value={contributionInr} />
                        <input type="hidden" name={`contribution_fx_rate_${row.categoryId}`} value="1" />
                        <input type="hidden" name={`closing_fx_rate_${row.categoryId}`} value="1" />
                        <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
                            Market movement is calculated as closing value minus the previous close and this actual contribution.
                        </div>
                    </>
                )}
            </div>

            <p className="mt-4 text-xs text-slate-400">
                {row.previousNativeValue === null
                    ? "This will establish the opening baseline. Growth starts calculating next month."
                    : `Previous close: ${row.currency === "USD" ? "$" : "₹"}${numberValue(row.previousNativeValue)}${row.currency === "USD" ? ` at ₹${numberValue(row.previousFxRate ?? 1, 4)}` : ""}.`}
            </p>
        </article>
    );
}

export function MonthlyReviewForm({
    rows,
    action,
}: {
    rows: MonthlyReviewFormRow[];
    action: (formData: FormData) => Promise<void>;
}) {
    const baselineCount = useMemo(() => rows.filter((row) => row.previousNativeValue === null).length, [rows]);

    return (
        <form action={action} className="space-y-4">
            {rows.map((row) => <MonthlyRow key={row.categoryId} row={row} />)}
            <div className="sticky bottom-4 flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-slate-500">
                    {baselineCount > 0
                        ? `${baselineCount} categories will establish their first performance baseline.`
                        : "Saving recalculates this month from the previous monthly close."}
                </p>
                <FormSubmitButton pendingText="Saving monthly review...">Save monthly review</FormSubmitButton>
            </div>
        </form>
    );
}
