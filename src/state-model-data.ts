import {
    AbstractionLimitError, constructAbstractModel, runKey,
    type AbstractionRules, type AbstractModel, type AnalysisSource,
    type Observation, type RecordedExecution, type RecordedRun, type RecordedSequence,
} from "testar-abstraction";
import { ReconstructedEvidence, evidenceEvent, type EventType, type EventData } from "testar-evidence";
import { AsmError, requireAsm } from "./errors.js";
import { compareText, compareList, copy, digest, freeze, key, same } from "./data.js";
import type { EvidenceSnapshot, SourceSnapshot, RunReference } from "./types.js";

export const STATUSES = ["completed", "failed", "incomplete", "awaiting_execution_result", "awaiting_resulting_observation"] as const;
export const PENDING = new Set<string>(STATUSES.slice(3));
const COLLECTIONS = ["runs", "sequences", "observations", "actions", "executions"] as const;
type Collection = typeof COLLECTIONS[number];

function recordId(name: Collection, record: any): string {
    return name === "executions" ? record.execution.id : record.id;
}

/** Own incoming records once and retain accepted immutable records when their contents match. */
export async function prepareSnapshot(input: EvidenceSnapshot, previous?: StateModelData) {
    try {
        requireAsm(Array.isArray(input.sources) && Array.isArray(input.selected_runs), "invalid_evidence", "Supply sources and selected runs.");
        const sources: SourceSnapshot[] = [];
        const identifiers = new Set<string>();
        for (const source of input.sources) {
            requireAsm(typeof source.id === "string" && !identifiers.has(source.id), "invalid_evidence", "Repeated or invalid source identity.");
            identifiers.add(source.id);
            const accepted = previous?.sources.get(source.id);
            const evidence: any = {};
            for (const name of COLLECTIONS) {
                const collection = source.evidence[name];
                const records: any[] = collection instanceof Map ? [...collection.values()] : collection as any[];
                requireAsm(Array.isArray(records), "invalid_evidence", "Evidence collections must be arrays or maps.");
                const old = new Map((accepted?.evidence[name] as any[] ?? []).map(record => [recordId(name, record), record]));
                const ids = new Set<string>();
                evidence[name] = records.map(record => {
                    const id = recordId(name, record);
                    requireAsm(typeof id === "string" && !ids.has(id), "invalid_evidence", "Repeated or invalid record identity.");
                    ids.add(id);
                    const known = old.get(id);
                    return known && same(known, record) ? known : freeze(copy(record));
                }).sort((a, b) => compareText(recordId(name, a), recordId(name, b)));
            }
            // Metadata is checked too; a caller's fingerprint never replaces content comparison.
            const metadata = copy({ id: source.id, label: source.label, fingerprint: source.fingerprint });
            sources.push(freeze({ ...metadata, evidence }));
        }
        sources.sort((a, b) => compareText(a.id, b.id));
        const selected_runs = [...copy([...input.selected_runs])].sort((a, b) => compareList([a.source, a.run], [b.source, b.run], compareText));
        const snapshot = freeze({ sources, selected_runs });
        return { snapshot, signature: await snapshotSignature(snapshot.sources, snapshot.selected_runs) };
    } catch (error) {
        if (error instanceof AsmError) {
            throw error;
        }
        throw new AsmError("invalid_evidence", "Invalid reconstructed evidence.", { cause: error });
    }
}

// Only our owned immutable records enter this cache; caller-provided fingerprints are never trusted.
const recordSignatures = new WeakMap<object, Promise<string>>();
async function snapshotSignature(sources: SourceSnapshot[], selectedRuns: RunReference[]): Promise<string> {
    const signatures = [];
    for (const source of sources) {
        const evidence: Record<string, string[]> = {};
        for (const name of COLLECTIONS) {
            evidence[name] = await Promise.all((source.evidence[name] as object[]).map(record => {
                let signature = recordSignatures.get(record);
                if (!signature) {
                    signature = digest(record);
                    recordSignatures.set(record, signature);
                }
                return signature;
            }));
        }
        signatures.push({id: source.id, label: source.label, fingerprint: source.fingerprint, evidence});
    }
    return digest({sources: signatures, selected_runs: selectedRuns});
}

function stripLifecycle(record: RecordedRun | RecordedSequence): any {
    const {status, reason, ...facts} = record;
    return facts;
}

/** Validate a source's references and lifecycle through the evidence library before accepting it. */
function validateSource(source: SourceSnapshot): void {
    const evidence = source.evidence;
    const history = new ReconstructedEvidence({ schema_version: 3, evidence_id: source.id });
    function apply<K extends EventType>(type: K, data: unknown) {
        history.apply(evidenceEvent(String(history.eventCount + 1), type, data as EventData[K]));
    }
    for (const action of evidence.actions) {
        apply("action_described", action);
    }
    for (const run of evidence.runs) {
        apply("test_run_started", stripLifecycle(run));
        const sequences = evidence.sequences.filter(item => item.test_run === run.id)
            .sort((a, b) => a.sequence_index < b.sequence_index ? -1 : a.sequence_index > b.sequence_index ? 1 : 0);
        for (const sequence of sequences) {
            apply("test_sequence_started", stripLifecycle(sequence));
            const observations = evidence.observations.filter(item => item.test_sequence === sequence.id)
                .sort((a, b) => a.observation_index < b.observation_index ? -1 : a.observation_index > b.observation_index ? 1 : 0);
            const executions = evidence.executions.filter(item => item.execution.test_sequence === sequence.id);
            for (const observation of observations) {
                apply("observation_recorded", observation);
                for (const record of executions) {
                    if (record.resultingObservation === observation.id) {
                        apply("transition_recorded", { action_execution: record.execution.id, resulting_observation: observation.id });
                    }
                }
                for (const record of executions) {
                    if (record.execution.source_observation === observation.id) {
                        apply("action_selected", record.execution);
                        if (record.executionResult !== null) {
                            apply("action_execution_reported", record.executionResult);
                        }
                    }
                }
            }
            requireAsm(sequence.status === "running" || sequence.status === "finished", "invalid_evidence", "Unknown sequence status.");
            if (sequence.status === "finished") {
                apply("test_sequence_finished", { test_sequence: sequence.id, reason: sequence.reason ?? "Recorded sequence finished" });
            }
        }
        requireAsm(run.status === "running" || run.status === "finished", "invalid_evidence", "Unknown run status.");
        if (run.status === "finished") {
            apply("test_run_finished", { test_run: run.id, reason: run.reason ?? "Recorded run finished" });
        }
    }
    requireAsm(history.observations.length === evidence.observations.length &&
        history.testSequences.length === evidence.sequences.length &&
        history.actionExecutions.length === evidence.executions.length, "invalid_evidence", "Unresolved evidence records.");
    for (const record of evidence.executions) {
        requireAsm(history.actionExecution(record.execution.id)?.status === record.status, "invalid_evidence", "Execution status differs from its lifecycle.");
    }
}

function checkExtension(previous: SourceSnapshot, incoming: SourceSnapshot): void {
    for (const name of COLLECTIONS) {
        const indexed = new Map((incoming.evidence[name] as any[]).map(record => [recordId(name, record), record]));
        for (const before of previous.evidence[name] as any[]) {
            const after = indexed.get(recordId(name, before));
            requireAsm(after, "conflicting_evidence", "An accepted record was removed.");
            if (name === "observations" || name === "actions") {
                requireAsm(before === after || same(before, after), "conflicting_evidence", "An immutable record changed.");
            } else if (name === "executions") {
                requireAsm(same(before.execution, after.execution), "conflicting_evidence", "Execution arguments changed.");
                for (const field of ["executionResult", "resultingObservation"]) {
                    requireAsm(before[field] === null || same(before[field], after[field]), "conflicting_evidence", "An accepted execution result changed.");
                }
                requireAsm(PENDING.has(before.status) || before.status === after.status, "conflicting_evidence", "A final execution status changed.");
                requireAsm(before.status !== "awaiting_resulting_observation" || after.status !== "awaiting_execution_result",
                    "conflicting_evidence", "Execution lifecycle regressed.");
            } else {
                requireAsm(same(stripLifecycle(before), stripLifecycle(after)), "conflicting_evidence", "Run or sequence content changed.");
                requireAsm(before.status !== "finished" || same(before, after), "conflicting_evidence", "A finished lifecycle changed.");
            }
        }
    }
}

export type PreparedSnapshot = Awaited<ReturnType<typeof prepareSnapshot>>;

/** Accepted trace records and their abstract model. Candidate updates are built separately. */
export class StateModelData {
    sources = new Map<string, SourceSnapshot>();
    runs = new Set<string>();
    observations = new Map<string, Observation>();
    executions = new Map<string, RecordedExecution>();
    sequences = new Map<string, RecordedSequence>();
    runRecords = new Map<string, RecordedRun>();
    model!: AbstractModel;
    signature!: string;
    selectedRuns!: RunReference[];

    static async create(prepared: PreparedSnapshot, rules: AbstractionRules, previous?: StateModelData): Promise<StateModelData> {
        try {
            const incoming = prepared.snapshot;
            if (previous) {
                requireAsm([...previous.runs].every(id => incoming.selected_runs.some(item => key(item.source, item.run) === id)),
                    "conflicting_evidence", "Selected runs cannot be removed.");
            }
            const merged = new Map(previous?.sources);
            for (const source of incoming.sources) {
                const before = merged.get(source.id);
                if (before) {
                    checkExtension(before, source);
                }
                merged.set(source.id, source);
            }
            const sources = [...merged.values()].sort((a, b) => compareText(a.id, b.id));
            const signature = await snapshotSignature(sources, incoming.selected_runs);
            if (previous?.signature === signature) {
                return previous;
            }
            const data = new StateModelData();
            data.signature = signature;
            data.sources = merged;
            data.selectedRuns = incoming.selected_runs;
            for (const source of sources) {
                if (!previous?.sources.has(source.id) || !same(previous.sources.get(source.id), source)) {
                    validateSource(source);
                }
            }
            const analysisSources: AnalysisSource[] = sources.map(source => ({
                ...source,
                evidence: {
                    runs: new Map(source.evidence.runs.map(record => [record.id, record])),
                    sequences: new Map(source.evidence.sequences.map(record => [record.id, record])),
                    observations: new Map(source.evidence.observations.map(record => [record.id, record])),
                    actions: new Map(source.evidence.actions.map(record => [record.id, record])),
                    executions: new Map(source.evidence.executions.map(record => [record.execution.id, record])),
                },
            }));
            for (const reference of data.selectedRuns) {
                const id = key(reference.source, reference.run);
                requireAsm(!data.runs.has(id), "invalid_evidence", "Repeated selected run.");
                data.runs.add(id);
                const evidence = merged.get(reference.source)?.evidence;
                const run = evidence?.runs.find(item => item.id === reference.run);
                requireAsm(run && evidence, "invalid_evidence", "Unknown selected run.");
                data.runRecords.set(id, run);
                for (const sequence of evidence.sequences.filter(item => item.test_run === reference.run)) {
                    data.sequences.set(key(reference.source, sequence.id), sequence);
                    for (const observation of evidence.observations.filter(item => item.test_sequence === sequence.id)) {
                        data.observations.set(key(reference.source, reference.run, observation.id), observation);
                    }
                    for (const record of evidence.executions.filter(item => item.execution.test_sequence === sequence.id)) {
                        data.executions.set(key(reference.source, reference.run, record.execution.id), record);
                    }
                }
            }
            const constructed = await constructAbstractModel(analysisSources, rules, data.selectedRuns.map(item => runKey(item.source, item.run)));
            data.model = freeze(constructed.model);
            return data;
        } catch (error) {
            if (error instanceof AsmError) {
                throw error;
            }
            throw new AsmError(error instanceof AbstractionLimitError ? "processing_limit" : "invalid_evidence",
                error instanceof Error ? error.message : "Invalid evidence.", { cause: error });
        }
    }
}
