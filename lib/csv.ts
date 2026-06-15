export type CsvRow = Record<string, string>;

export function escapeCsvValue(value: unknown): string {
    const stringValue = String(value ?? "");

    if (
        stringValue.includes(",") ||
        stringValue.includes("\n") ||
        stringValue.includes("\r") ||
        stringValue.includes('"')
    ) {
        return `"${stringValue.replace(/"/g, '""')}"`;
    }

    return stringValue;
}

export function toCsv(headers: string[], rows: Record<string, unknown>[]) {
    const headerLine = headers.map(escapeCsvValue).join(",");

    const rowLines = rows.map((row) =>
        headers.map((header) => escapeCsvValue(row[header])).join(",")
    );

    return [headerLine, ...rowLines].join("\n");
}

export function parseCsv(text: string): CsvRow[] {
    const rows: string[][] = [];
    let currentRow: string[] = [];
    let currentValue = "";
    let insideQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const nextChar = text[index + 1];

        if (char === '"' && insideQuotes && nextChar === '"') {
            currentValue += '"';
            index += 1;
            continue;
        }

        if (char === '"') {
            insideQuotes = !insideQuotes;
            continue;
        }

        if (char === "," && !insideQuotes) {
            currentRow.push(currentValue);
            currentValue = "";
            continue;
        }

        if ((char === "\n" || char === "\r") && !insideQuotes) {
            if (char === "\r" && nextChar === "\n") {
                index += 1;
            }

            currentRow.push(currentValue);

            if (currentRow.some((value) => value.trim() !== "")) {
                rows.push(currentRow);
            }

            currentRow = [];
            currentValue = "";
            continue;
        }

        currentValue += char;
    }

    currentRow.push(currentValue);

    if (currentRow.some((value) => value.trim() !== "")) {
        rows.push(currentRow);
    }

    if (rows.length === 0) {
        return [];
    }

    const headers = rows[0].map((header) => normalizeHeader(header));

    return rows.slice(1).map((row) => {
        const record: CsvRow = {};

        headers.forEach((header, index) => {
            record[header] = row[index]?.trim() ?? "";
        });

        return record;
    });
}

export function normalizeHeader(header: string): string {
    return header.trim().toLowerCase().replace(/\s+/g, "_");
}

export function requireHeaders(
    rows: CsvRow[],
    requiredHeaders: string[],
    label: string
) {
    if (rows.length === 0) {
        throw new Error(`${label} CSV has no data rows.`);
    }

    const availableHeaders = new Set(Object.keys(rows[0] ?? {}));
    const missingHeaders = requiredHeaders.filter(
        (header) => !availableHeaders.has(header)
    );

    if (missingHeaders.length > 0) {
        throw new Error(
            `${label} CSV is missing required columns: ${missingHeaders.join(", ")}.`
        );
    }
}