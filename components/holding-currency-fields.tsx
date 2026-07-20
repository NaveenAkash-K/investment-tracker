"use client";

import { useState } from "react";

export function HoldingCurrencyFields({ defaultUsdInrRate }: { defaultUsdInrRate: number }) {
    const [currency, setCurrency] = useState<"INR" | "USD">("INR");
    const [rate, setRate] = useState("1.000000");
    return <>
        <div className="lg:col-span-1">
            <label htmlFor="currency" className="block text-sm font-medium text-slate-700">Currency</label>
            <select id="currency" name="currency" value={currency} onChange={(event) => {
                const next = event.target.value as "INR" | "USD";
                setCurrency(next);
                setRate(next === "INR" ? "1.000000" : defaultUsdInrRate.toFixed(6));
            }} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950 outline-none ring-slate-300 focus:ring-2">
                <option value="INR">INR</option><option value="USD">USD</option>
            </select>
        </div>
        <div className="lg:col-span-2">
            <label htmlFor="exchange_rate_to_inr" className="block text-sm font-medium text-slate-700">Rate to INR</label>
            <input id="exchange_rate_to_inr" name="exchange_rate_to_inr" type="number" min="0.000001" step="0.000001" value={rate} readOnly={currency === "INR"} onChange={(event) => setRate(event.target.value)} required className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950 outline-none ring-slate-300 focus:ring-2 read-only:bg-slate-50" />
        </div>
    </>;
}
