"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { parseCsv, requireHeaders, type CsvRow } from "@/lib/csv";
import { getIndiaDate } from "@/lib/performance";

function readCheckbox(formData: FormData, key: string): boolean {
    return formData.get(key) === "on";
}

function readNumber(row: CsvRow, key: string, fallbackValue: number): number {
    const rawValue = String(row[key] ?? "").trim().replace(/,/g, "");

    if (!rawValue) {
        return fallbackValue;
    }

    const value = Number(rawValue);

    if (!Number.isFinite(value)) {
        throw new Error(`${key} must be a valid number.`);
    }

    return value;
}

function readIntegerOrNull(row: CsvRow, key: string): number | null {
    const rawValue = String(row[key] ?? "").trim();

    if (!rawValue) {
        return null;
    }

    const value = Number(rawValue);

    if (!Number.isInteger(value)) {
        throw new Error(`${key} must be a valid whole number.`);
    }

    return value;
}

function normalizeCurrency(value: string): string {
    const currency = value.trim().toUpperCase() || "INR";

    if (!["INR", "USD"].includes(currency)) {
        throw new Error("Currency must be INR or USD.");
    }

    return currency;
}

function today(): string {
    return getIndiaDate();
}

export async function restoreFullBackup(formData: FormData) {
    const { supabase } = await getSessionContext();
    const fileValue = formData.get("file");
    if (!(fileValue instanceof File) || fileValue.size === 0) throw new Error("Choose a JSON backup file.");
    if (fileValue.size > 15 * 1024 * 1024) throw new Error("Backup file is larger than 15 MB.");

    let backup: unknown;
    try { backup = JSON.parse(await fileValue.text()); }
    catch { throw new Error("The selected file is not valid JSON."); }

    if (!backup || typeof backup !== "object") throw new Error("Invalid backup structure.");
    const record = backup as { format?: unknown; version?: unknown; data?: unknown };
    if (record.format !== "investment-tracker-backup" || record.version !== 1 || !record.data) {
        throw new Error("This is not a supported Investment Tracker backup.");
    }

    const { error } = await supabase.rpc("restore_complete_portfolio_backup_v2", { p_backup: backup });
    if (error) throw new Error(error.message);
    revalidatePath("/", "layout");
    redirect("/import-export?restored=1");
}

function readBoolean(row: CsvRow, key: string, fallbackValue: boolean) {
    const value = String(row[key] ?? "").trim().toLowerCase();
    if (!value) return fallbackValue;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`${key} must be true or false.`);
}

async function getFileText(formData: FormData): Promise<string> {
    const file = formData.get("file");

    if (!(file instanceof File)) {
        throw new Error("CSV file is required.");
    }

    if (!file.name.toLowerCase().endsWith(".csv")) {
        throw new Error("Please upload a .csv file.");
    }

    const text = await file.text();

    if (!text.trim()) {
        throw new Error("CSV file is empty.");
    }

    return text;
}

async function getSessionContext() {
    const supabase = await createClient();

    const {
        data: { user },
        error,
    } = await supabase.auth.getUser();

    if (error || !user) {
        redirect("/auth/login");
    }

    return {
        supabase,
        userId: user.id,
    };
}

async function getCategoryMap(
    supabase: Awaited<ReturnType<typeof createClient>>,
    userId: string
) {
    const { data, error } = await supabase
        .from("asset_categories")
        .select("id, name")
        .eq("user_id", userId);

    if (error) {
        throw new Error(error.message);
    }

    return new Map(
        (data ?? []).map((category) => [
            category.name.trim().toLowerCase(),
            category.id,
        ])
    );
}

function getCategoryId(categoryMap: Map<string, string>, categoryName: string) {
    const categoryId = categoryMap.get(categoryName.trim().toLowerCase());

    if (!categoryId) {
        throw new Error(`Unknown category: ${categoryName}`);
    }

    return categoryId;
}

export async function importHoldings(formData: FormData) {
    const { supabase, userId } = await getSessionContext();

    const replaceExisting = readCheckbox(formData, "replace_existing");
    const text = await getFileText(formData);
    const rows = parseCsv(text);

    requireHeaders(
        rows,
        [
            "name",
            "category",
            "currency",
            "current_value",
            "exchange_rate_to_inr",
        ],
        "Holdings"
    );

    const categoryMap = await getCategoryMap(supabase, userId);

    const holdingRows = rows.map((row, index) => {
        const name = String(row.name ?? "").trim();
        const categoryName = String(row.category ?? "").trim();

        if (!name) {
            throw new Error(`Row ${index + 2}: name is required.`);
        }

        if (!categoryName) {
            throw new Error(`Row ${index + 2}: category is required.`);
        }

        const currentValue = readNumber(row, "current_value", 0);
        const exchangeRateToInr = readNumber(row, "exchange_rate_to_inr", 1);

        if (currentValue < 0) {
            throw new Error(`Row ${index + 2}: current_value cannot be negative.`);
        }

        if (exchangeRateToInr <= 0) {
            throw new Error(
                `Row ${index + 2}: exchange_rate_to_inr must be greater than zero.`
            );
        }

        return {
            user_id: userId,
            category_id: getCategoryId(categoryMap, categoryName),
            name,
            asset_type: String(row.asset_type ?? "Other").trim() || "Other",
            currency: normalizeCurrency(String(row.currency ?? "INR")),
            current_value: currentValue,
            exchange_rate_to_inr: exchangeRateToInr,
            notes: String(row.notes ?? "").trim() || null,
            is_active: readBoolean(row, "is_active", true),
            last_updated_at: String(row.last_updated_at ?? "").trim() || today(),
        };
    });

    const { error } = await supabase.rpc("replace_holdings", {
        p_rows: holdingRows,
        p_replace: replaceExisting,
    });

    if (error) {
        throw new Error(error.message);
    }

    revalidatePath("/import-export");
    revalidatePath("/holdings");
    revalidatePath("/dashboard");
    revalidatePath("/targets");
    redirect("/import-export");
}

export async function importSipPlans(formData: FormData) {
    const { supabase, userId } = await getSessionContext();

    const replaceExisting = readCheckbox(formData, "replace_existing");
    const text = await getFileText(formData);
    const rows = parseCsv(text);

    requireHeaders(rows, ["name", "category", "monthly_amount"], "SIP Plan");

    const categoryMap = await getCategoryMap(supabase, userId);

    const sipRows = rows.map((row, index) => {
        const name = String(row.name ?? "").trim();
        const categoryName = String(row.category ?? "").trim();

        if (!name) {
            throw new Error(`Row ${index + 2}: name is required.`);
        }

        if (!categoryName) {
            throw new Error(`Row ${index + 2}: category is required.`);
        }

        const monthlyAmount = readNumber(row, "monthly_amount", 0);
        const sipDay = readIntegerOrNull(row, "sip_day");

        if (monthlyAmount < 0) {
            throw new Error(`Row ${index + 2}: monthly_amount cannot be negative.`);
        }

        if (sipDay !== null && (sipDay < 1 || sipDay > 31)) {
            throw new Error(`Row ${index + 2}: sip_day must be between 1 and 31.`);
        }

        return {
            user_id: userId,
            category_id: getCategoryId(categoryMap, categoryName),
            name,
            monthly_amount: monthlyAmount,
            sip_day: sipDay,
            notes: String(row.notes ?? "").trim() || null,
            is_active: readBoolean(row, "is_active", true),
        };
    });

    const { error } = await supabase.rpc("replace_sip_plans", {
        p_rows: sipRows,
        p_replace: replaceExisting,
    });

    if (error) {
        throw new Error(error.message);
    }

    revalidatePath("/import-export");
    revalidatePath("/sip-plan");
    revalidatePath("/dashboard");
    revalidatePath("/targets");
    redirect("/import-export");
}

export async function importTargets(formData: FormData) {
    const { supabase, userId } = await getSessionContext();

    const text = await getFileText(formData);
    const rows = parseCsv(text);

    requireHeaders(rows, ["category", "target_percentage"], "Targets");

    const categoryMap = await getCategoryMap(supabase, userId);

    const targetRows = rows.map((row, index) => {
        const categoryName = String(row.category ?? "").trim();

        if (!categoryName) {
            throw new Error(`Row ${index + 2}: category is required.`);
        }

        const targetPercentage = readNumber(row, "target_percentage", 0);

        if (targetPercentage < 0 || targetPercentage > 100) {
            throw new Error(
                `Row ${index + 2}: target_percentage must be between 0 and 100.`
            );
        }

        return {
            user_id: userId,
            category_id: getCategoryId(categoryMap, categoryName),
            target_percentage: targetPercentage,
        };
    });

    const uniqueCategoryIds = new Set(targetRows.map((row) => row.category_id));
    if (uniqueCategoryIds.size !== targetRows.length) {
        throw new Error("Targets CSV contains the same category more than once.");
    }
    if (uniqueCategoryIds.size !== categoryMap.size) {
        throw new Error("Targets CSV must contain every configured asset category exactly once.");
    }

    const totalTargetPercentage = targetRows.reduce(
        (sum, row) => sum + row.target_percentage,
        0
    );

    if (Math.abs(totalTargetPercentage - 100) > 0.01) {
        throw new Error(
            `Target allocation total must be 100%. Current total is ${totalTargetPercentage.toFixed(
                2
            )}%.`
        );
    }

    const { error } = await supabase.rpc("replace_targets", {
        p_rows: targetRows,
    });

    if (error) {
        throw new Error(error.message);
    }

    revalidatePath("/import-export");
    revalidatePath("/targets");
    revalidatePath("/dashboard");
    revalidatePath("/sip-plan");
    redirect("/import-export");
}
