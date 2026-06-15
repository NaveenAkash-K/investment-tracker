import type { InputHTMLAttributes, ReactNode } from "react";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { createClient } from "@/lib/supabase/server";
import { signOutFromSettings, updateProfileSettings } from "./actions";
import { addCategory, deleteCategory, updateCategory } from "./category-actions";

type Profile = {
    id: string;
    user_id: string;
    display_name: string | null;
    base_currency: string | null;
    default_usd_inr_rate: number | string | null;
    created_at: string | null;
    updated_at: string | null;
};

type Category = {
    id: string;
    name: string;
    sort_order: number | null;
};

type Target = {
    category_id: string;
    target_percentage: number | string | null;
};

type HoldingRef = {
    category_id: string;
};

type SipPlanRef = {
    category_id: string;
};

export default async function SettingsPage() {
    const supabase = await createClient();

    const {
        data: { user },
        error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
        redirect("/auth/login");
    }

    const [
        profileResult,
        categoriesResult,
        targetsResult,
        holdingsResult,
        sipPlansResult,
    ] = await Promise.all([
        supabase
            .from("profiles")
            .select(
                "id, user_id, display_name, base_currency, default_usd_inr_rate, created_at, updated_at"
            )
            .eq("user_id", user.id)
            .maybeSingle(),

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
            .select("category_id")
            .eq("is_active", true)
            .eq("user_id", user.id),

        supabase
            .from("sip_plans")
            .select("category_id")
            .eq("is_active", true)
            .eq("user_id", user.id),
    ]);

    const queryError =
        profileResult.error ||
        categoriesResult.error ||
        targetsResult.error ||
        holdingsResult.error ||
        sipPlansResult.error;

    if (queryError) {
        return (
            <main className="mx-auto max-w-6xl px-4 py-8">
                <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-red-800">
                    <h1 className="text-xl font-semibold">Settings error</h1>
                    <p className="mt-2 text-sm">{queryError.message}</p>
                </div>
            </main>
        );
    }

    const profile = profileResult.data as Profile | null;
    const categories = (categoriesResult.data ?? []) as Category[];
    const targets = (targetsResult.data ?? []) as Target[];
    const holdings = (holdingsResult.data ?? []) as HoldingRef[];
    const sipPlans = (sipPlansResult.data ?? []) as SipPlanRef[];


    function toNumber(value: unknown): number {
        const numberValue = Number(value ?? 0);
        return Number.isFinite(numberValue) ? numberValue : 0;
    }

    function inputNumberValue(value: unknown, decimals = 6): string {
        return toNumber(value || 1).toFixed(decimals);
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

    const targetByCategoryId = new Map<string, number>();
    const holdingsCountByCategoryId = new Map<string, number>();
    const sipCountByCategoryId = new Map<string, number>();

    const totalTarget = categories.reduce(
        (sum, category) => sum + (targetByCategoryId.get(category.id) ?? 0),
        0
    );

    for (const target of targets) {
        targetByCategoryId.set(
            target.category_id,
            toNumber(target.target_percentage)
        );
    }

    for (const holding of holdings) {
        holdingsCountByCategoryId.set(
            holding.category_id,
            (holdingsCountByCategoryId.get(holding.category_id) ?? 0) + 1
        );
    }

    for (const sip of sipPlans) {
        sipCountByCategoryId.set(
            sip.category_id,
            (sipCountByCategoryId.get(sip.category_id) ?? 0) + 1
        );
    }

    return (
        <main>
            <div className="mx-auto max-w-7xl px-4 py-8">
                <PageHeader
                    title="Settings"
                    description="Manage profile defaults, export shortcuts, and account actions."
                />

                <section className="grid gap-4 md:grid-cols-3">
                    <SummaryCard
                        label="Signed in as"
                        value={user.email ?? "-"}
                        helper="Account"
                    />
                    {/*<SummaryCard*/}
                    {/*    label="Base currency"*/}
                    {/*    value={profile?.base_currency ?? "INR"}*/}
                    {/*    helper="Only INR is supported for portfolio calculations."*/}
                    {/*/>*/}
                    <SummaryCard
                        label="Default USD/INR"
                        value={inputNumberValue(profile?.default_usd_inr_rate ?? 1, 4)}
                        helper="Used for USD holdings default"
                    />
                </section>

                <section className="mt-6 grid gap-6 lg:grid-cols-2">
                    <div className="rounded-xl border border-slate-200 bg-white p-5">
                        <h2 className="text-lg font-semibold text-slate-950">
                            Profile defaults
                        </h2>
                        <p className="mt-1 text-sm leading-6 text-slate-500">
                            These settings are used to prefill common values across the app.
                            You can still override values per holding.
                        </p>

                        <form action={updateProfileSettings} className="mt-5 space-y-4">
                            <div>
                                <Label htmlFor="display_name">Display name</Label>
                                <Input
                                    id="display_name"
                                    name="display_name"
                                    defaultValue={profile?.display_name ?? ""}
                                    placeholder="Naveen"
                                />
                            </div>

                            {/*<div>*/}
                            {/*    <Label htmlFor="base_currency">Base currency</Label>*/}
                            {/*    <select*/}
                            {/*        id="base_currency"*/}
                            {/*        name="base_currency"*/}
                            {/*        defaultValue={profile?.base_currency ?? "INR"}*/}
                            {/*        className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950 outline-none ring-slate-300 focus:ring-2"*/}
                            {/*    >*/}
                            {/*        <option value="INR">INR</option>*/}
                            {/*    </select>*/}
                            {/*    <p className="mt-1 text-xs text-slate-500">*/}
                            {/*        Only INR is supported for portfolio calculations.*/}
                            {/*    </p>*/}
                            {/*</div>*/}

                            <div>
                                <Label htmlFor="default_usd_inr_rate">
                                    Default USD/INR rate
                                </Label>
                                <Input
                                    id="default_usd_inr_rate"
                                    name="default_usd_inr_rate"
                                    type="number"
                                    min="0.000001"
                                    step="0.000001"
                                    defaultValue={inputNumberValue(
                                        profile?.default_usd_inr_rate ?? 1,
                                        6
                                    )}
                                    required
                                />
                                <p className="mt-1 text-xs text-slate-500">
                                    Example: 95.280000. This will be used as the default exchange
                                    rate when adding USD holdings.
                                </p>
                            </div>

                            <button
                                type="submit"
                                className="rounded-lg bg-slate-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
                            >
                                Save settings
                            </button>
                        </form>
                    </div>

                    <div className="space-y-6">
                        <div className="rounded-xl border border-slate-200 bg-white p-5">
                            <h2 className="text-lg font-semibold text-slate-950">
                                Account
                            </h2>

                            <dl className="mt-4 space-y-3 text-sm">
                                <div className="flex justify-between gap-4">
                                    <dt className="text-slate-500">Email</dt>
                                    <dd className="text-right font-medium text-slate-950">
                                        {user.email ?? "-"}
                                    </dd>
                                </div>

                                <div className="flex justify-between gap-4">
                                    <dt className="text-slate-500">User ID</dt>
                                    <dd className="max-w-56 truncate text-right font-mono text-xs text-slate-600">
                                        {user.id}
                                    </dd>
                                </div>

                                <div className="flex justify-between gap-4">
                                    <dt className="text-slate-500">Profile updated</dt>
                                    <dd className="text-right font-medium text-slate-950">
                                        {formatDateTime(profile?.updated_at)}
                                    </dd>
                                </div>
                            </dl>

                            <form action={signOutFromSettings} className="mt-5">
                                <button
                                    type="submit"
                                    className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                                >
                                    Sign out
                                </button>
                            </form>
                        </div>

                        <div className="rounded-xl border border-slate-200 bg-white p-5">
                            <h2 className="text-lg font-semibold text-slate-950">
                                Quick exports
                            </h2>
                            <p className="mt-1 text-sm leading-6 text-slate-500">
                                Download a CSV backup anytime.
                            </p>

                            <div className="mt-4 grid gap-3 sm:grid-cols-2">
                                <ExportLink href="/api/export/holdings">
                                    Export holdings
                                </ExportLink>
                                <ExportLink href="/api/export/sip-plans">
                                    Export SIPs
                                </ExportLink>
                                <ExportLink href="/api/export/targets">
                                    Export targets
                                </ExportLink>
                                <ExportLink href="/api/export/snapshots">
                                    Export snapshots
                                </ExportLink>
                            </div>
                        </div>
                    </div>
                </section>

                <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
                    <div>
                        <h2 className="text-lg font-semibold text-slate-950">
                            Asset categories
                        </h2>
                        <p className="mt-1 text-sm leading-6 text-slate-500">
                            Manage the asset groups used across holdings, SIPs, targets, snapshots,
                            import, and export.
                        </p>
                    </div>

                    <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
                        <p className="text-sm font-medium text-slate-950">
                            Target total: {totalTarget.toFixed(2)}%
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                            Target total should equal 100%. Adjust exact target percentages on the
                            Targets page.
                        </p>
                    </div>

                    <form action={addCategory} className="mt-5 grid gap-4 md:grid-cols-4">
                        <div>
                            <Label htmlFor="category_name">Category name</Label>
                            <Input
                                id="category_name"
                                name="name"
                                placeholder="Crypto"
                                required
                            />
                        </div>

                        <div>
                            <Label htmlFor="category_sort_order">Sort order</Label>
                            <Input
                                id="category_sort_order"
                                name="sort_order"
                                type="number"
                                step="1"
                                defaultValue="99"
                                required
                            />
                        </div>

                        <div>
                            <Label htmlFor="category_target_percentage">Initial target %</Label>
                            <Input
                                id="category_target_percentage"
                                name="target_percentage"
                                type="number"
                                min="0"
                                max="100"
                                step="0.01"
                                defaultValue="0"
                                required
                            />
                        </div>

                        <div className="flex items-end">
                            <button
                                type="submit"
                                className="w-full rounded-lg bg-slate-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
                            >
                                Add category
                            </button>
                        </div>
                    </form>

                    <div className="mt-6 overflow-x-auto">
                        <table className="w-full min-w-[850px] text-left text-sm">
                            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                            <tr>
                                <th className="px-4 py-3">Category</th>
                                <th className="px-4 py-3 text-right">Sort order</th>
                                <th className="px-4 py-3 text-right">Target %</th>
                                <th className="px-4 py-3 text-right">Holdings</th>
                                <th className="px-4 py-3 text-right">SIPs</th>
                                <th className="px-4 py-3">Actions</th>
                            </tr>
                            </thead>

                            <tbody className="divide-y divide-slate-100">
                            {categories.map((category) => {
                                const holdingsCount =
                                    holdingsCountByCategoryId.get(category.id) ?? 0;
                                const sipCount = sipCountByCategoryId.get(category.id) ?? 0;
                                const canDelete = holdingsCount === 0 && sipCount === 0;

                                return (
                                    <tr key={category.id} className="text-slate-700">
                                        <td className="px-4 py-4">
                                            <form
                                                id={`update-category-${category.id}`}
                                                action={updateCategory}
                                            >
                                                <input
                                                    type="hidden"
                                                    name="category_id"
                                                    value={category.id}
                                                />
                                                <Input
                                                    name="name"
                                                    defaultValue={category.name}
                                                    required
                                                    className="max-w-72"
                                                />
                                            </form>
                                        </td>

                                        <td className="px-4 py-4">
                                            <Input
                                                form={`update-category-${category.id}`}
                                                name="sort_order"
                                                type="number"
                                                step="1"
                                                defaultValue={String(category.sort_order ?? 99)}
                                                className="ml-auto max-w-28 text-right"
                                                required
                                            />
                                        </td>

                                        <td className="px-4 py-4 text-right">
                                            {(targetByCategoryId.get(category.id) ?? 0).toFixed(2)}%
                                        </td>

                                        <td className="px-4 py-4 text-right">{holdingsCount}</td>
                                        <td className="px-4 py-4 text-right">{sipCount}</td>

                                        <td className="px-4 py-4">
                                            <div className="flex flex-wrap items-center gap-3">
                                                <button
                                                    form={`update-category-${category.id}`}
                                                    type="submit"
                                                    className="rounded-lg bg-slate-950 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
                                                >
                                                    Save
                                                </button>

                                                <form action={deleteCategory}>
                                                    <input
                                                        type="hidden"
                                                        name="category_id"
                                                        value={category.id}
                                                    />
                                                    <button
                                                        type="submit"
                                                        disabled={!canDelete}
                                                        className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                                                    >
                                                        Delete
                                                    </button>
                                                </form>
                                            </div>

                                            {!canDelete && (
                                                <p className="mt-2 text-xs text-slate-500">
                                                    Move or archive active holdings/SIPs first.
                                                </p>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}

                            {categories.length === 0 && (
                                <tr>
                                    <td
                                        colSpan={6}
                                        className="px-4 py-10 text-center text-slate-500"
                                    >
                                        No categories found.
                                    </td>
                                </tr>
                            )}
                            </tbody>
                        </table>
                    </div>
                </section>

                <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
                    <h2 className="text-lg font-semibold text-slate-950">
                        App data safety
                    </h2>

                    <div className="mt-4 grid gap-4 md:grid-cols-3">
                        <InfoBox
                            title="Manual tracker"
                            text="This app does not connect to brokers or exchanges. You control all updates manually."
                        />
                        <InfoBox
                            title="CSV backup"
                            text="Export holdings and snapshots periodically so you always have a local copy."
                        />
                        <InfoBox
                            title="User isolation"
                            text="Database rows are protected with user_id and Supabase Row Level Security."
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
            <p className="mt-2 truncate text-2xl font-bold text-slate-950">
                {value}
            </p>
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

function ExportLink({
                        href,
                        children,
                    }: {
    href: string;
    children: ReactNode;
}) {
    return (
        <a
            href={href}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-center text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
            {children}
        </a>
    );
}

function InfoBox({
                     title,
                     text,
                 }: {
    title: string;
    text: string;
}) {
    return (
        <div className="rounded-lg bg-slate-50 p-4">
            <h3 className="text-sm font-semibold text-slate-950">{title}</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">{text}</p>
        </div>
    );
}