import { JsonNumber } from "testar-evidence";
import { copy, same } from "./data.js";

const immutableInputs = new WeakSet<object>();
const ownedCopies = new WeakMap<object, object>();

/** Check the complete plain-data tree: freezing only the outer record does not make its properties immutable. */
function deeplyImmutable(value: unknown, ancestors = new Set<object>()): boolean {
    if (value === null || typeof value !== "object") {
        return true;
    }
    if (value instanceof JsonNumber || immutableInputs.has(value)) {
        return true;
    }
    const prototype = Object.getPrototypeOf(value);
    if (!Object.isFrozen(value) || ancestors.has(value) ||
        (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) ||
        Object.getOwnPropertySymbols(value).length !== 0) {
        return false;
    }
    ancestors.add(value);
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (Array.isArray(value) && name === "length") {
            continue;
        }
        if (!("value" in descriptor) || !descriptor.enumerable || !deeplyImmutable(descriptor.value, ancestors)) {
            ancestors.delete(value);
            return false;
        }
    }
    ancestors.delete(value);
    immutableInputs.add(value);
    return true;
}

/** Detach mutable input every time; immutable evidence objects can reuse their already checked owned copy. */
export function ownRecord<T extends object>(record: T, known?: T): T {
    const cached = ownedCopies.get(record) as T | undefined;
    if (cached) {
        return known && same(known, cached) ? known : cached;
    }
    const owned = known && same(known, record) ? known : copy(record);
    if (deeplyImmutable(record)) {
        ownedCopies.set(record, owned);
    }
    return owned;
}
