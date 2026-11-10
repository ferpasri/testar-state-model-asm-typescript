export type AsmErrorCode =
    | "invalid_configuration" | "invalid_evidence" | "conflicting_evidence" | "conflicting_update"
    | "invalid_context" | "context_conflict" | "stale_context" | "stale_selection"
    | "invalid_selection" | "execution_in_progress" | "unknown_execution"
    | "execution_reference_reused" | "execution_mismatch" | "execution_already_recorded"
    | "cancelled" | "processing_limit";

/** A rejected operation retains the previous accepted evidence and selection state. */
export class AsmError extends Error {
    constructor(public readonly code: AsmErrorCode, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "AsmError";
    }
}

export function requireAsm(condition: unknown, code: AsmErrorCode, message: string): asserts condition {
    if (!condition) {
        throw new AsmError(code, message);
    }
}
