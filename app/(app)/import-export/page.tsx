import type { ReactNode } from "react";
import { PageHeader } from "@/components/page-header";
import { importHoldings, importSipPlans, importTargets } from "./actions";

const holdingsTemplate = `name,category,asset_type,currency,current_value,exchange_rate_to_inr,notes
Parag Parikh Flexi Cap Fund,Indian Assets,Mutual Fund,INR,48628.53,1,Flexi cap
VOO,US Assets,US ETF,USD,213.09,95.28,S&P 500 ETF
Bitcoin,Crypto,Crypto,INR,6424.92,1,BTC`;

const sipTemplate = `name,category,monthly_amount,sip_day,notes
Parag Parikh Flexi Cap Fund,Indian Assets,6500,5,Core flexi cap SIP
US Stocks,US Assets,10000,,Monthly US ETF allocation
Crypto,Crypto,2000,,Monthly crypto allocation`;

const targetTemplate = `category,target_percentage
Indian Assets,60
US Assets,15
Debt,10
Gold & Silver,10
Crypto,5`;

export default function ImportExportPage() {
    return (
        <main>
            <div className="mx-auto max-w-7xl px-4 py-8">
                <PageHeader
                    title="Import / Export"
                    description="Export your portfolio data to CSV and import clean CSV templates for holdings, SIPs, and target allocation."
                />

                <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <ExportCard
                        title="Holdings"
                        description="Download all holdings, including archived rows."
                        href="/api/export/holdings"
                    />
                    <ExportCard
                        title="SIP Plans"
                        description="Download active and archived SIP plans."
                        href="/api/export/sip-plans"
                    />
                    <ExportCard
                        title="Targets"
                        description="Download your current target allocation."
                        href="/api/export/targets"
                    />
                    <ExportCard
                        title="Snapshots"
                        description="Download historical snapshots, category rows, SIP rows, and notes."
                        href="/api/export/snapshots"
                    />
                </section>

                <section className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5">
                    <h2 className="text-base font-semibold text-amber-900">
                        Import rules
                    </h2>
                    <div className="mt-3 grid gap-3 text-sm leading-6 text-amber-800 md:grid-cols-3">
                        <p>
                            Category names must exactly match your app categories: Indian
                            Assets, US Assets, Debt, Gold & Silver, Crypto.
                        </p>
                        <p>
                            Imports support clean CSV templates only. Do not upload broker
                            statements or random Excel exports yet.
                        </p>
                        <p>
                            Use “replace existing active rows” when you want the CSV to become
                            the new source of truth.
                        </p>
                    </div>
                </section>

                <section className="mt-6 grid gap-6 xl:grid-cols-3">
                    <ImportCard
                        title="Import Holdings"
                        description="Required columns: name, category, currency, current_value, exchange_rate_to_inr. Optional: asset_type, notes."
                        action={importHoldings}
                        template={holdingsTemplate}
                        replaceLabel="Archive existing active holdings before import"
                    />

                    <ImportCard
                        title="Import SIP Plan"
                        description="Required columns: name, category, monthly_amount. Optional: sip_day, notes."
                        action={importSipPlans}
                        template={sipTemplate}
                        replaceLabel="Archive existing active SIPs before import"
                    />

                    <ImportCard
                        title="Import Targets"
                        description="Required columns: category, target_percentage. Total target percentage must equal 100%."
                        action={importTargets}
                        template={targetTemplate}
                    />
                </section>

                <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
                    <h2 className="text-lg font-semibold text-slate-950">
                        Recommended monthly workflow
                    </h2>

                    <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm leading-6 text-slate-600">
                        <li>Export holdings as backup.</li>
                        <li>Update values in Excel if that is easier.</li>
                        <li>Import holdings CSV with replace option enabled.</li>
                        <li>Review Dashboard and Targets.</li>
                        <li>Create monthly snapshot.</li>
                    </ol>
                </section>
            </div>
        </main>
    );
}

function ExportCard({
                        title,
                        description,
                        href,
                    }: {
    title: string;
    description: string;
    href: string;
}) {
    return (
        <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-lg font-semibold text-slate-950">{title}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">{description}</p>

            <a
                href={href}
                className="mt-4 inline-flex rounded-lg bg-slate-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
            >
                Export CSV
            </a>
        </div>
    );
}

function ImportCard({
                        title,
                        description,
                        action,
                        template,
                        replaceLabel,
                    }: {
    title: string;
    description: string;
    action: (formData: FormData) => void | Promise<void>;
    template: string;
    replaceLabel?: string;
}) {
    return (
        <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-lg font-semibold text-slate-950">{title}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">{description}</p>

            <form action={action} className="mt-5 space-y-4">
                <div>
                    <label
                        htmlFor={`${title}_file`}
                        className="block text-sm font-medium text-slate-700"
                    >
                        CSV file
                    </label>
                    <input
                        id={`${title}_file`}
                        name="file"
                        type="file"
                        accept=".csv,text/csv"
                        required
                        className="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950 file:mr-4 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700"
                    />
                </div>

                {replaceLabel && (
                    <label className="flex items-start gap-2 text-sm leading-6 text-slate-700">
                        <input
                            type="checkbox"
                            name="replace_existing"
                            className="mt-1 h-4 w-4 rounded border-slate-300"
                        />
                        <span>{replaceLabel}</span>
                    </label>
                )}

                <button
                    type="submit"
                    className="rounded-lg bg-slate-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
                >
                    Import CSV
                </button>
            </form>

            <details className="mt-5 rounded-lg border border-slate-200">
                <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-slate-700">
                    View template
                </summary>

                <pre className="overflow-x-auto border-t border-slate-200 bg-slate-50 p-4 text-xs leading-5 text-slate-700">
          {template}
        </pre>
            </details>
        </div>
    );
}

function InfoBox({ children }: { children: ReactNode }) {
    return (
        <div className="rounded-lg bg-slate-50 p-4 text-sm leading-6 text-slate-600">
            {children}
        </div>
    );
}