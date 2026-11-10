import { JsonNumber, copyJson, equalJson } from "testar-evidence";

export function copy<T>(value: T): T {
    return copyJson(value) as T;
}
export function same(left: unknown, right: unknown): boolean {
    return left === right || equalJson(left, right);
}
export function freeze<T>(value: T): T {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            freeze(child);
        }
        Object.freeze(value);
    }
    return value;
}
/** Compare identifiers in Unicode code-point order, including supplementary characters. */
export function compareText(left: string, right: string): number {
    const a = Array.from(left, character => character.codePointAt(0)!);
    const b = Array.from(right, character => character.codePointAt(0)!);
    return compareList(a, b, (x, y) => x - y);
}
export function compareList<T>(left: readonly T[], right: readonly T[], compare: (a: T, b: T) => number): number {
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
        const result = compare(left[index], right[index]);
        if (result !== 0) {
            return result;
        }
    }
    return left.length - right.length;
}
export function refParts(reference: {source: string; run: string; observation?: string; execution?: string}): string[] {
    return [reference.source, reference.run, reference.observation ?? reference.execution!];
}
export function compareReference(left: Parameters<typeof refParts>[0], right: Parameters<typeof refParts>[0]): number {
    return compareList(refParts(left), refParts(right), compareText);
}
export function key(...parts: unknown[]): string {
    return JSON.stringify(parts);
}
export function refKey(reference: Parameters<typeof refParts>[0]): string {
    return key(...refParts(reference));
}

/** Stable retry identity: equivalent numbers match without rounding to a JavaScript number. */
export function canonical(value: unknown): string {
    if (typeof value === "number" || typeof value === "bigint" || value instanceof JsonNumber) {
        const text = value instanceof JsonNumber ? value.text : String(value);
        const [coefficient, exponentText = "0"] = text.toLowerCase().split("e");
        const negative = coefficient.startsWith("-");
        const unsigned = negative ? coefficient.slice(1) : coefficient;
        const [whole, fraction = ""] = unsigned.split(".");
        let digits = (whole + fraction).replace(/^0+/, "");
        let exponent = BigInt(exponentText) - BigInt(fraction.length);
        if (digits.length === 0) {
            return "n:0";
        }
        while (digits.endsWith("0")) {
            digits = digits.slice(0, -1);
            exponent++;
        }
        return "n:" + (negative ? "-" : "") + digits + "e" + exponent;
    }
    if (Array.isArray(value)) {
        return "[" + value.map(canonical).join(",") + "]";
    }
    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return "{" + Object.keys(record).sort(compareText).map(name => JSON.stringify(name) + ":" + canonical(record[name])).join(",") + "}";
    }
    return JSON.stringify(value);
}
export async function digest(value: unknown): Promise<string> {
    const bytes = new TextEncoder().encode(canonical(value));
    const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
