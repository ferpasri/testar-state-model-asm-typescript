import { parseAbstractionRules, type AbstractModel, type ExecutionReference } from "testar-abstraction";
import { stringifyJson } from "testar-evidence";
import { AsmError, requireAsm } from "./errors.js";
import { RandomActionSelector } from "./random-action-selector.js";
import { UnvisitedActionSelector } from "./unvisited-action-selector.js";
import { copy, freeze, key, refKey, same } from "./data.js";
import { PENDING, StateModelData, prepareSnapshot } from "./state-model-data.js";
import type {
    AsmConfiguration, ChooseIndex, ObservationContext, OperationResult,
    SelectedAction, SelectionToken, SelectionResult, SourceInput, RunReference,
} from "./types.js";
import { explore, type ExplorationDriver } from "./exploration.js";

interface ExecutionContext {
    context: ObservationContext;
    choice: ObservationContext["choices"][number];
    invoked: boolean | null;
}

/** Own one exploration run: accepted evidence, action selection, limits, and execution reporting. */
export class AsmRun {
    #configuration: AsmConfiguration;
    #data!: StateModelData;
    #revision = 0;
    #chooseIndex: ChooseIndex;
    #context: ObservationContext | null = null;
    #contexts = new Map<string, ObservationContext>();
    #decision: SelectedAction | null = null;
    #cancelled = false;
    #active: string | null = null;
    #executions = new Map<string, ExecutionContext>();
    #updates = new Map<string, string>();
    #asmIndex = 0;
    #entryCount = 0;
    #totalCount = 0;
    #counted = new Set<string>();
    #queue: Promise<unknown> = Promise.resolve();

    private constructor(configuration: AsmConfiguration, chooseIndex?: ChooseIndex) {
        try {
            const candidate = {...copy(configuration)};
            requireAsm(candidate && Object.keys(candidate).every(name => ["abstraction", "asms", "total_action_limit"].includes(name)),
                "invalid_configuration", "Unknown configuration option.");
            candidate.abstraction = parseAbstractionRules(stringifyJson(candidate.abstraction));
            requireAsm(candidate.abstraction.actions, "invalid_configuration", "Action abstraction is required.");
            requireAsm(Array.isArray(candidate.asms) && candidate.asms.length > 0, "invalid_configuration", "Configure at least one ASM.");
            for (const entry of candidate.asms) {
                requireAsm(entry && ["random", "unvisited"].includes(entry.name), "invalid_configuration", "Unknown ASM.");
                const allowed = entry.name === "unvisited" ? ["name", "action_limit", "unmatched_choices"] : ["name", "action_limit"];
                requireAsm(Object.keys(entry).every(name => allowed.includes(name)), "invalid_configuration", "Unsupported ASM options.");
                requireAsm(Number.isSafeInteger(entry.action_limit) && entry.action_limit > 0, "invalid_configuration", "An ASM action limit must be positive.");
                if (entry.name === "unvisited") {
                    requireAsm(["exclude", "isolated"].includes(entry.unmatched_choices ?? "exclude"), "invalid_configuration", "Unknown unmatched-choice policy.");
                }
            }
            if (candidate.total_action_limit !== undefined) {
                requireAsm(Number.isSafeInteger(candidate.total_action_limit) && candidate.total_action_limit > 0,
                    "invalid_configuration", "The overall action limit must be positive.");
            }
            requireAsm(chooseIndex === undefined || typeof chooseIndex === "function", "invalid_configuration", "Supply a random index function.");
            this.#configuration = freeze(candidate);
            this.#chooseIndex = chooseIndex ?? randomIndex;
        } catch (error) {
            if (error instanceof AsmError) {
                throw error;
            }
            throw new AsmError("invalid_configuration", "Invalid ASM configuration.", {cause: error});
        }
    }

    /** Resolve rules and build the initial model, optionally from selected historical traces. */
    static async create(configuration: AsmConfiguration, sources: readonly SourceInput[] = [], selectedRuns: readonly RunReference[] = [],
        options: {chooseIndex?: ChooseIndex} = {}): Promise<AsmRun> {
        const run = new AsmRun(configuration, options.chooseIndex);
        run.#data = await StateModelData.create(await prepareSnapshot({sources, selected_runs: selectedRuns}), run.#configuration.abstraction);
        return run;
    }

    get asmDataRevision(): number { return this.#revision; }
    /** Immutable snapshot; retaining it cannot change this run or a later model. */
    get model(): AbstractModel { return this.#data.model; }
    get selectedRuns(): readonly RunReference[] { return this.#data.selectedRuns; }

    // Calls remain ordered across asynchronous model construction and rejected operations.
    private serial<T>(operation: () => T | Promise<T>): Promise<T> {
        const result = this.#queue.then(operation);
        this.#queue = result.then(() => undefined, () => undefined);
        return result;
    }

    private result(result_type: string, fields: Omit<OperationResult, "result_type" | "asm_data_revision"> = {}): OperationResult {
        return freeze({result_type, asm_data_revision: this.#revision, ...fields});
    }

    private retireContext(): void {
        this.#context = null;
        this.#decision = null;
    }

    /** Bind eligible executable choices to the latest recorded observation in an active sequence. */
    setContext(context: ObservationContext): Promise<OperationResult> {
        return this.serial(() => {
            requireAsm(this.#active === null, "execution_in_progress", "Report the outstanding execution first.");
            let candidate: ObservationContext;
            try {
                candidate = freeze(copy(context));
                const identifier = candidate.context_id;
                requireAsm(typeof identifier === "string" && identifier.trim(), "invalid_context", "A context ID is required.");
                const previous = this.#contexts.get(identifier);
                if (previous) {
                    requireAsm(same(previous, candidate), "context_conflict", "The context identifier has different content.");
                    requireAsm(this.#context?.context_id === identifier, "stale_context", "This context has been retired.");
                    return this.result("context_ready", {context_id: identifier});
                }
                const reference = candidate.observation;
                const observation = this.#data.observations.get(refKey(reference));
                requireAsm(observation, "invalid_context", "Unknown observation.");
                const sequence = this.#data.sequences.get(key(reference.source, observation.test_sequence));
                const run = this.#data.runRecords.get(key(reference.source, reference.run));
                requireAsm(sequence?.status === "running" && run?.status === "running", "invalid_context", "The sequence or run has finished.");
                for (const [id, recorded] of this.#data.observations) {
                    if (id === key(reference.source, reference.run, recorded.id) && recorded.test_sequence === observation.test_sequence) {
                        requireAsm(recorded.observation_index <= observation.observation_index, "invalid_context", "A newer observation exists.");
                    }
                }
                for (const [id, record] of this.#data.executions) {
                    requireAsm(id !== key(reference.source, reference.run, record.execution.id) ||
                        record.execution.test_sequence !== observation.test_sequence || !PENDING.has(record.status),
                        "execution_in_progress", "Resolve the sequence's pending execution.");
                }
                requireAsm(Array.isArray(candidate.choices), "invalid_context", "Supply eligible choices.");
                const ids = new Set<string>();
                for (const choice of candidate.choices) {
                    requireAsm(typeof choice.choice_id === "string" && choice.choice_id.trim() && !ids.has(choice.choice_id),
                        "invalid_context", "Choice identifiers must be nonempty and unique.");
                    ids.add(choice.choice_id);
                    requireAsm(observation.available_actions.some(binding => binding.action_description === choice.action_description &&
                        binding.target_widget === choice.target_widget), "invalid_context", "Choice was not reported at this observation.");
                }
                this.#context = candidate;
                this.#contexts.set(identifier, candidate);
                this.#decision = null;
                return this.result("context_ready", {context_id: identifier});
            } catch (error) {
                if (error instanceof AsmError) {
                    throw error;
                }
                throw new AsmError("invalid_context", "Invalid observation context.", {cause: error});
            }
        });
    }

    private noAction(reason: string): SelectionResult {
        return freeze({result_type: "no_action", asm_data_revision: this.#revision, context_id: this.#context?.context_id ?? null,
            asm_index: this.#asmIndex, reason, message: reason.replaceAll("_", " "), rankings: []});
    }

    private stoppingReason(): string | null {
        if (this.#cancelled) {
            return "cancelled";
        }
        if (this.#active !== null) {
            return "execution_in_progress";
        }
        if (this.#totalCount >= (this.#configuration.total_action_limit ?? Infinity)) {
            return "action_limit_reached";
        }
        return null;
    }

    /** Return the same decision for repeated requests until context, evidence, or ASM changes. */
    select(): Promise<SelectionResult> {
        return this.serial(() => {
            const reason = this.stoppingReason();
            if (reason === "cancelled" || reason === "execution_in_progress") {
                return this.noAction(reason);
            }
            if (!this.#context) {
                return this.noAction("no_context");
            }
            if (reason) {
                return this.noAction(reason);
            }
            if (this.#context.choices.length === 0) {
                return this.noAction("no_available_choices");
            }
            if (this.#decision) {
                return this.#decision;
            }
            const entries = this.#configuration.asms;
            const start = this.#asmIndex;
            let index = start;
            let count = this.#entryCount;
            if (count >= entries[index].action_limit) {
                index = (index + 1) % entries.length;
                count = 0;
            }
            let fallback: ReturnType<UnvisitedActionSelector["select"]> | undefined;
            for (let attempt = 0; attempt < entries.length; attempt++) {
                const Selector = entries[index].name === "random" ? RandomActionSelector : UnvisitedActionSelector;
                const result = new Selector(this.#data, this.#context, this.#chooseIndex).select(entries[index]);
                if (result.choice_id !== undefined) {
                    const selected = freeze({
                        result_type: "selected", asm_data_revision: this.#revision,
                        context_id: this.#context.context_id, asm_index: index,
                        message: result.reason.replaceAll("_", " "), ...result,
                    }) as SelectedAction;
                    this.#asmIndex = index;
                    this.#entryCount = count;
                    this.#decision = selected;
                    return selected;
                }
                fallback ??= result;
                index = (index + 1) % entries.length;
                count = 0;
            }
            const failed = entries.length === 1 ? fallback! : {reason: "no_applicable_asm", rankings: fallback!.rankings};
            return freeze({...this.noAction(failed.reason), rankings: failed.rankings, asm_index: start});
        });
    }

    /** Check the last selection immediately before the driver invokes the selected browser operation. */
    beginExecution(selection: SelectionToken, execution: ExecutionReference): Promise<OperationResult> {
        return this.serial(() => {
            requireAsm(!this.#cancelled, "cancelled", "Exploration was cancelled.");
            requireAsm(this.#active === null, "execution_in_progress", "Another execution is outstanding.");
            requireAsm(this.#context && this.#decision && selection.context_id === this.#context.context_id &&
                selection.asm_data_revision === this.#revision, "stale_selection", "Select again using current evidence.");
            requireAsm(selection.choice_id === this.#decision.choice_id, "invalid_selection", "This is not the last selected choice.");
            requireAsm(execution && [execution.source, execution.run, execution.execution].every(item => typeof item === "string" && item.trim()),
                "execution_mismatch", "Supply a source-qualified execution identity.");
            execution = checkedExecutionReference(execution);
            const id = refKey(execution);
            requireAsm(!this.#executions.has(id) && !this.#data.executions.has(id), "execution_reference_reused", "Execution identity has already been used.");
            requireAsm(execution.source === this.#context.observation.source && execution.run === this.#context.observation.run,
                "execution_mismatch", "Execution must belong to the selected run.");
            const choice = this.#context.choices.find(item => item.choice_id === selection.choice_id)!;
            this.#executions.set(id, {context: this.#context, choice, invoked: null});
            this.#active = id;
            return this.result("execution_started", {execution: freeze(copy(execution)), context_id: this.#context.context_id});
        });
    }

    private async prepareUpdate(updateId: string, sources: readonly SourceInput[], selectedRuns: readonly RunReference[]) {
        requireAsm(typeof updateId === "string" && updateId.trim(), "invalid_evidence", "An update ID is required.");
        const prepared = await prepareSnapshot({sources, selected_runs: selectedRuns}, this.#data);
        const previous = this.#updates.get(updateId);
        requireAsm(previous === undefined || previous === prepared.signature, "conflicting_update", "Update identifier has different content.");
        const candidate = await StateModelData.create(prepared, this.#configuration.abstraction, this.#data);
        return {candidate, signature: prepared.signature};
    }

    private acceptUpdate(updateId: string, candidate: StateModelData, signature: string): boolean {
        this.#updates.set(updateId, signature);
        if (candidate === this.#data) {
            return false;
        }
        this.#data = candidate;
        this.#revision++;
        this.#decision = null;
        if (this.#context) {
            const reference = this.#context.observation;
            const current = candidate.observations.get(refKey(reference))!;
            const active = candidate.runRecords.get(key(reference.source, reference.run))?.status === "running" &&
                candidate.sequences.get(key(reference.source, current.test_sequence))?.status === "running";
            const newer = [...candidate.observations].some(([id, observation]) =>
                id === key(reference.source, reference.run, observation.id) && observation.test_sequence === current.test_sequence &&
                observation.observation_index > current.observation_index);
            if (!active || newer) {
                this.retireContext();
            }
        }
        return true;
    }

    /** Accept full source snapshots, preserving old records and retaining sources omitted from this update. */
    updateEvidence(updateId: string, sources: readonly SourceInput[], selectedRuns: readonly RunReference[]): Promise<OperationResult> {
        return this.serial(async () => {
            const {candidate, signature} = await this.prepareUpdate(updateId, sources, selectedRuns);
            return this.result("evidence_updated", {changed: this.acceptUpdate(updateId, candidate, signature)});
        });
    }

    /** Count an invoked action once, while accepting successive pending and terminal evidence reports. */
    reportExecution(execution: ExecutionReference, updateId: string, sources: readonly SourceInput[], selectedRuns: readonly RunReference[]): Promise<OperationResult> {
        return this.serial(async () => {
            execution = checkedExecutionReference(execution);
            const id = refKey(execution);
            const executionContext = this.#executions.get(id);
            requireAsm(executionContext && executionContext.invoked !== false, "unknown_execution", "Execution was not begun through this ASM.");
            const {candidate, signature} = await this.prepareUpdate(updateId, sources, selectedRuns);
            const record = candidate.executions.get(id);
            requireAsm(record, "execution_mismatch", "The reported execution is missing.");
            const original = executionContext.context.observation;
            const choice = executionContext.choice;
            requireAsm(record.execution.source_observation === original.observation &&
                record.execution.action_description === choice.action_description && record.execution.target_widget === choice.target_widget,
                "execution_mismatch", "Reported execution does not belong to the selected action.");
            const changed = this.acceptUpdate(updateId, candidate, signature);
            executionContext.invoked = true;
            if (!this.#counted.has(id)) {
                this.#counted.add(id);
                this.#entryCount++;
                this.#totalCount++;
            }
            if (!PENDING.has(record.status) && this.#active === id) {
                this.#active = null;
                this.retireContext();
            }
            return this.result("execution_updated", {execution: freeze(copy(execution)), status: record.status, changed});
        });
    }

    /** Clear an operation that was never invoked; it consumes no action count and needs a fresh context. */
    reportNotInvoked(execution: ExecutionReference): Promise<OperationResult> {
        return this.serial(() => {
            execution = checkedExecutionReference(execution);
            const id = refKey(execution);
            requireAsm(this.#executions.has(id) && this.#active === id, "unknown_execution", "No such outstanding execution.");
            requireAsm(!this.#data.executions.has(id), "execution_already_recorded", "Execution evidence already exists.");
            this.#executions.get(id)!.invoked = false;
            this.#active = null;
            this.retireContext();
            return this.result("execution_not_invoked", {execution: freeze(copy(execution))});
        });
    }

    /** Stop further selections; final reports for an already started action remain accepted. */
    cancel(): Promise<OperationResult> {
        return this.serial(() => {
            this.#cancelled = true;
            return this.result("cancelled");
        });
    }

    /** Check cancellation and limits before asking the driver to capture another state. */
    explorationStop(): Promise<SelectionResult | null> {
        return this.serial(() => {
            const reason = this.stoppingReason();
            return reason ? this.noAction(reason) : null;
        });
    }

    /** Coordinate action derivation, selection, execution, and reporting through a technology driver. */
    explore(driver: ExplorationDriver, options: {maxCycles?: number} = {}) {
        return explore(this, driver, options);
    }
}

/** Rejection sampling avoids favoring smaller indices when the range does not divide 2^32. */
function randomIndex(size: number): number {
    requireAsm(Number.isSafeInteger(size) && size > 0 && size <= 0x100000000, "processing_limit", "Random choice range is too large.");
    const limit = Math.floor(0x100000000 / size) * size;
    const bytes = new Uint32Array(1);
    do {
        globalThis.crypto.getRandomValues(bytes);
    } while (bytes[0] >= limit);
    return bytes[0] % size;
}

function checkedExecutionReference(reference: ExecutionReference): ExecutionReference {
    try {
        requireAsm(reference && [reference.source, reference.run, reference.execution].every(value =>
            typeof value === "string" && value.trim()), "execution_mismatch", "Supply a source-qualified execution identity.");
        return freeze(copy(reference));
    } catch (error) {
        if (error instanceof AsmError) {
            throw error;
        }
        throw new AsmError("execution_mismatch", "Invalid execution reference.", {cause: error});
    }
}
