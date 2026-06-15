import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
    addHolding,
    archiveHolding,
    bulkUpdateHoldingValues,
    updateHolding,
} from "./actions";
import {PageHeader} from "@/components/page-header";

type Category = {
    id: string;
    name: string;
    sort_order: number | null;
};

type Holding = {
    id: string;
    category_id: string;
    name: string;
    asset_type: string | null;
    currency: string | null;
    current_value: number | string | null;
    exchange_rate_to_inr: number | string | null;
    current_value_inr: number | string | null;
    notes: string | null;
    is_active: boolean | null;
    last_updated_at: string | null;
};

const assetTypes = [
    "Mutual Fund",
    "Indian Stock",
    "US ETF",
    "US Stock",
    "Crypto",
    "Gold ETF",
    "Silver ETF",
    "Liquid Fund",
    "Debt Fund",
    "Other",
];

function toNumber(value: unknown): number {
    const numberValue = Number(value ?? 0);
    return Number.isFinite(numberValue) ? numberValue : 0;
}

function formatCurrency(value: number): string {
    return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 2,
    }).format(value);
}

function formatDate(value: string | null | undefined): string {
    if (!value) return "Not updated yet";

    return new Intl.DateTimeFormat("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
    }).format(new Date(value));
}

function inputNumberValue(value: unknown, decimals = 2): string {
    return toNumber(value).toFixed(decimals);
}

export default async function HoldingsPage() {
    const supabase = await createClient();

    const {
        data: { user },
        error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
        redirect("/auth/login");
    }

    const [categoriesResult, holdingsResult, profileResult] = await Promise.all([
        supabase
            .from("asset_categories")
            .select("id, name, sort_order")
            .eq("user_id", user.id)
            .order("sort_order", { ascending: true }),

        supabase
            .from("holdings")
            .select(
                "id, category_id, name, asset_type, currency, current_value, exchange_rate_to_inr, current_value_inr, notes, is_active, last_updated_at"
            )
            .eq("user_id", user.id)
            .eq("is_active", true)
            .order("last_updated_at", { ascending: false })
            .order("name", { ascending: true }),

        supabase
            .from("profiles")
            .select("default_usd_inr_rate")
            .eq("user_id", user.id)
            .maybeSingle(),
    ]);

    const queryError =
        categoriesResult.error || holdingsResult.error || profileResult.error;

    if (queryError) {
        return (
            <main className="mx-auto max-w-6xl px-4 py-8">
                <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-red-800">
                    <h1 className="text-xl font-semibold">Holdings error</h1>
                    <p className="mt-2 text-sm">{queryError.message}</p>
                </div>
            </main>
        );
    }

    const categories = (categoriesResult.data ?? []) as Category[];
    const holdings = (holdingsResult.data ?? []) as Holding[];

    const defaultUsdInrRate = toNumber(
        profileResult.data?.default_usd_inr_rate ?? 1
    );

    const categoryById = new Map(categories.map((category) => [category.id, category]));
    const totalValueInr = holdings.reduce(
        (sum, holding) => sum + toNumber(holding.current_value_inr),
        0
    );

    const lastUpdatedDate =
        holdings
            .map((holding) => holding.last_updated_at)
            .filter(Boolean)
            .sort()
            .at(-1) ?? null;

    return (
        <main className="min-h-screen bg-slate-50">
            <div className="mx-auto max-w-7xl px-4 py-8">
                <PageHeader
                    title="Holdings"
                    description="Add holdings and manually update their current values every month."
                />

                <section className="grid gap-4 sm:grid-cols-3">
                    <SummaryCard
                        label="Total holdings value"
                        value={formatCurrency(totalValueInr)}
                        helper="Active holdings only"
                    />
                    <SummaryCard
                        label="Active holdings"
                        value={String(holdings.length)}
                        helper="Archived holdings are hidden"
                    />
                    <SummaryCard
                        label="Last updated"
                        value={formatDate(lastUpdatedDate)}
                        helper="Based on holding updates"
                    />
                </section>

                <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
                    <div className="mb-5">
                        <h2 className="text-lg font-semibold text-slate-950">
                            Add new holding
                        </h2>
                        <p className="mt-1 text-sm text-slate-500">
                            For INR assets, use exchange rate 1. For US assets, enter USD
                            value and USD/INR rate.
                        </p>
                    </div>

                    <form action={addHolding} className="grid gap-4 lg:grid-cols-12">
                        <div className="lg:col-span-3">
                            <Label htmlFor="name">Holding name</Label>
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
                            <Label htmlFor="asset_type">Asset type</Label>
                            <Select id="asset_type" name="asset_type" defaultValue="Other">
                                {assetTypes.map((assetType) => (
                                    <option key={assetType} value={assetType}>
                                        {assetType}
                                    </option>
                                ))}
                            </Select>
                        </div>

                        <div className="lg:col-span-1">
                            <Label htmlFor="currency">Currency</Label>
                            <Select id="currency" name="currency" defaultValue="INR">
                                <option value="INR">INR</option>
                                <option value="USD">USD</option>
                            </Select>
                        </div>

                        <div className="lg:col-span-2">
                            <Label htmlFor="current_value">Current value</Label>
                            <Input
                                id="current_value"
                                name="current_value"
                                type="number"
                                min="0"
                                step="0.01"
                                placeholder="48628.53"
                                required
                            />
                        </div>

                        <div className="lg:col-span-2">
                            <Label htmlFor="exchange_rate_to_inr">Rate to INR</Label>
                            <Input
                                id="exchange_rate_to_inr"
                                name="exchange_rate_to_inr"
                                type="number"
                                min="0.000001"
                                step="0.000001"
                                defaultValue={inputNumberValue(defaultUsdInrRate, 6)}
                                required
                            />
                        </div>

                        <div className="lg:col-span-10">
                            <Label htmlFor="notes">Notes</Label>
                            <Input
                                id="notes"
                                name="notes"
                                placeholder="Optional note"
                            />
                        </div>

                        <div className="flex items-end lg:col-span-2">
                            <button
                                type="submit"
                                className="w-full rounded-lg bg-slate-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
                            >
                                Add holding
                            </button>
                        </div>
                    </form>
                </section>

                <section className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
                    <div className="border-b border-slate-200 px-5 py-4">
                        <h2 className="text-lg font-semibold text-slate-950">
                            Monthly value update
                        </h2>
                        <p className="mt-1 text-sm text-slate-500">
                            Update current value and exchange rate here once a month. INR
                            value refreshes after saving.
                        </p>
                    </div>

                    {holdings.length > 0 ? (
                        <form action={bulkUpdateHoldingValues}>
                            <div className="overflow-x-auto">
                                <table className="w-full min-w-[850px] text-left text-sm">
                                    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                    <tr>
                                        <th className="px-5 py-3">Holding</th>
                                        <th className="px-5 py-3">Category</th>
                                        <th className="px-5 py-3">Currency</th>
                                        <th className="px-5 py-3 text-right">Current value</th>
                                        <th className="px-5 py-3 text-right">Rate to INR</th>
                                        <th className="px-5 py-3 text-right">Value in INR</th>
                                    </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-100">
                                    {holdings.map((holding) => (
                                        <tr key={holding.id}>
                                            <td className="px-5 py-4">
                                                <input
                                                    type="hidden"
                                                    name="holding_id"
                                                    value={holding.id}
                                                />
                                                <div className="font-medium text-slate-950">
                                                    {holding.name}
                                                </div>
                                                <div className="mt-1 text-xs text-slate-500">
                                                    {holding.asset_type || "Other"} · Updated{" "}
                                                    {formatDate(holding.last_updated_at)}
                                                </div>
                                            </td>
                                            <td className="px-5 py-4 text-slate-600">
                                                {categoryById.get(holding.category_id)?.name ||
                                                    "Unknown"}
                                            </td>
                                            <td className="px-5 py-4 text-slate-600">
                                                {holding.currency || "INR"}
                                            </td>
                                            <td className="px-5 py-4">
                                                <Input
                                                    name={`current_value_${holding.id}`}
                                                    type="number"
                                                    min="0"
                                                    step="0.01"
                                                    defaultValue={inputNumberValue(
                                                        holding.current_value,
                                                        2
                                                    )}
                                                    className="ml-auto max-w-40 text-right"
                                                    required
                                                />
                                            </td>
                                            <td className="px-5 py-4">
                                                <Input
                                                    name={`exchange_rate_to_inr_${holding.id}`}
                                                    type="number"
                                                    min="0.000001"
                                                    step="0.000001"
                                                    defaultValue={inputNumberValue(
                                                        holding.exchange_rate_to_inr,
                                                        6
                                                    )}
                                                    className="ml-auto max-w-40 text-right"
                                                    required
                                                />
                                            </td>
                                            <td className="px-5 py-4 text-right font-medium text-slate-950">
                                                {formatCurrency(toNumber(holding.current_value_inr))}
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
                                    Save monthly values
                                </button>
                            </div>
                        </form>
                    ) : (
                        <div className="px-5 py-10 text-center text-sm text-slate-500">
                            No holdings yet. Add your first holding above.
                        </div>
                    )}
                </section>

                <section className="mt-6">
                    <div className="mb-4">
                        <h2 className="text-lg font-semibold text-slate-950">
                            Detailed holdings
                        </h2>
                        <p className="mt-1 text-sm text-slate-500">
                            Edit details or archive holdings that you no longer want to track.
                        </p>
                    </div>

                    {holdings.length > 0 ? (
                        <div className="grid gap-4 lg:grid-cols-2">
                            {holdings.map((holding) => (
                                <article
                                    key={holding.id}
                                    className="rounded-xl border border-slate-200 bg-white p-5"
                                >
                                    <div className="flex items-start justify-between gap-4">
                                        <div>
                                            <h3 className="font-semibold text-slate-950">
                                                {holding.name}
                                            </h3>
                                            <p className="mt-1 text-sm text-slate-500">
                                                {categoryById.get(holding.category_id)?.name ||
                                                    "Unknown"}{" "}
                                                · {holding.asset_type || "Other"}
                                            </p>
                                        </div>

                                        <div className="text-right">
                                            <p className="font-semibold text-slate-950">
                                                {formatCurrency(toNumber(holding.current_value_inr))}
                                            </p>
                                            <p className="mt-1 text-xs text-slate-500">
                                                {holding.currency || "INR"}{" "}
                                                {inputNumberValue(holding.current_value, 2)}
                                            </p>
                                        </div>
                                    </div>

                                    {holding.notes && (
                                        <p className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
                                            {holding.notes}
                                        </p>
                                    )}

                                    <details className="mt-4 rounded-lg border border-slate-200">
                                        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-slate-700">
                                            Edit holding
                                        </summary>

                                        <form
                                            action={updateHolding}
                                            className="grid gap-4 border-t border-slate-200 p-4 sm:grid-cols-2"
                                        >
                                            <input
                                                type="hidden"
                                                name="holding_id"
                                                value={holding.id}
                                            />

                                            <div className="sm:col-span-2">
                                                <Label htmlFor={`name_${holding.id}`}>
                                                    Holding name
                                                </Label>
                                                <Input
                                                    id={`name_${holding.id}`}
                                                    name="name"
                                                    defaultValue={holding.name}
                                                    required
                                                />
                                            </div>

                                            <div>
                                                <Label htmlFor={`category_${holding.id}`}>
                                                    Category
                                                </Label>
                                                <Select
                                                    id={`category_${holding.id}`}
                                                    name="category_id"
                                                    defaultValue={holding.category_id}
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
                                                <Label htmlFor={`asset_type_${holding.id}`}>
                                                    Asset type
                                                </Label>
                                                <Select
                                                    id={`asset_type_${holding.id}`}
                                                    name="asset_type"
                                                    defaultValue={holding.asset_type || "Other"}
                                                >
                                                    {assetTypes.map((assetType) => (
                                                        <option key={assetType} value={assetType}>
                                                            {assetType}
                                                        </option>
                                                    ))}
                                                </Select>
                                            </div>

                                            <div>
                                                <Label htmlFor={`currency_${holding.id}`}>
                                                    Currency
                                                </Label>
                                                <Select
                                                    id={`currency_${holding.id}`}
                                                    name="currency"
                                                    defaultValue={holding.currency || "INR"}
                                                >
                                                    <option value="INR">INR</option>
                                                    <option value="USD">USD</option>
                                                </Select>
                                            </div>

                                            <div>
                                                <Label htmlFor={`current_value_${holding.id}`}>
                                                    Current value
                                                </Label>
                                                <Input
                                                    id={`current_value_${holding.id}`}
                                                    name="current_value"
                                                    type="number"
                                                    min="0"
                                                    step="0.01"
                                                    defaultValue={inputNumberValue(
                                                        holding.current_value,
                                                        2
                                                    )}
                                                    required
                                                />
                                            </div>

                                            <div>
                                                <Label htmlFor={`exchange_rate_${holding.id}`}>
                                                    Rate to INR
                                                </Label>
                                                <Input
                                                    id={`exchange_rate_${holding.id}`}
                                                    name="exchange_rate_to_inr"
                                                    type="number"
                                                    min="0.000001"
                                                    step="0.000001"
                                                    defaultValue={inputNumberValue(
                                                        holding.exchange_rate_to_inr,
                                                        6
                                                    )}
                                                    required
                                                />
                                            </div>

                                            <div className="sm:col-span-2">
                                                <Label htmlFor={`notes_${holding.id}`}>Notes</Label>
                                                <textarea
                                                    id={`notes_${holding.id}`}
                                                    name="notes"
                                                    defaultValue={holding.notes || ""}
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

                                    <form action={archiveHolding} className="mt-3">
                                        <input type="hidden" name="holding_id" value={holding.id} />
                                        <button
                                            type="submit"
                                            className="text-sm font-medium text-red-600 hover:text-red-700"
                                        >
                                            Archive holding
                                        </button>
                                    </form>
                                </article>
                            ))}
                        </div>
                    ) : (
                        <div className="rounded-xl border border-slate-200 bg-white px-5 py-10 text-center text-sm text-slate-500">
                            No holdings to show yet.
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
    children: React.ReactNode;
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
               }: React.InputHTMLAttributes<HTMLInputElement>) {
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
                }: React.SelectHTMLAttributes<HTMLSelectElement>) {
    return (
        <select
            {...props}
            className={`mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950 outline-none ring-slate-300 focus:ring-2 ${className}`}
        >
            {children}
        </select>
    );
}