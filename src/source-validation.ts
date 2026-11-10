import { ReconstructedEvidence, evidenceEvent, type EventType, type EventData } from "testar-evidence";
import { requireAsm } from "./errors.js";
import { same } from "./data.js";
import type { SourceSnapshot } from "./types.js";

function facts(record: {status: string; reason: string | null}): unknown {
    const {status, reason, ...content} = record;
    return content;
}

interface WorkingHistory {
    source: SourceSnapshot | null;
    history: ReconstructedEvidence;
}

/** Reuse lifecycle checks already accepted for this source; a rejected candidate invalidates the working history. */
export class SourceValidation {
    readonly source: SourceSnapshot;
    #working: WorkingHistory;

    private constructor(source: SourceSnapshot, working: WorkingHistory) {
        this.source = source;
        this.#working = working;
    }

    static validate(source: SourceSnapshot, previous?: SourceValidation): SourceValidation {
        // A previous candidate may have been rejected after validation. Reconstruct the
        // accepted checkpoint before reusing its history, never the rejected candidate.
        let working = previous ? previous.#working : undefined;
        if (!working || working.source !== previous!.source) {
            working = {source: null, history: new ReconstructedEvidence({schema_version: 3, evidence_id: source.id})};
            if (previous) {
                SourceValidation.extend(previous.source, working.history);
                working.source = previous.source;
            }
        }
        working.source = null;
        SourceValidation.extend(source, working.history);
        working.source = source;
        return new SourceValidation(source, working);
    }

    private static extend(source: SourceSnapshot, history: ReconstructedEvidence): void {
        const evidence = source.evidence;
        function apply<K extends EventType>(type: K, data: unknown) {
            history.apply(evidenceEvent(String(history.eventCount + 1), type, data as EventData[K]));
        }
        for (const action of evidence.actions) {
            if (!history.actionDescription(action.id)) {
                apply("action_described", action);
            }
        }
        for (const run of evidence.runs) {
            if (!history.testRun(run.id)) {
                apply("test_run_started", facts(run));
            }
            const sequences = evidence.sequences.filter(item => item.test_run === run.id)
                .sort((a, b) => a.sequence_index < b.sequence_index ? -1 : a.sequence_index > b.sequence_index ? 1 : 0);
            for (const sequence of sequences) {
                if (!history.testSequence(sequence.id)) {
                    apply("test_sequence_started", facts(sequence));
                }
                const observations = evidence.observations.filter(item => item.test_sequence === sequence.id)
                    .sort((a, b) => a.observation_index < b.observation_index ? -1 : a.observation_index > b.observation_index ? 1 : 0);
                const executions = evidence.executions.filter(item => item.execution.test_sequence === sequence.id);
                const from = new Map<string, typeof executions>();
                const to = new Map<string, typeof executions>();
                for (const record of executions) {
                    const start = record.execution.source_observation;
                    from.set(start, [...(from.get(start) ?? []), record]);
                    if (record.resultingObservation !== null) {
                        const end = record.resultingObservation;
                        to.set(end, [...(to.get(end) ?? []), record]);
                    }
                }
                for (const observation of observations) {
                    if (!history.observation(observation.id)) {
                        apply("observation_recorded", observation);
                    }
                    for (const record of to.get(observation.id) ?? []) {
                        if (history.actionExecution(record.execution.id)?.resulting_observation === null) {
                            apply("transition_recorded", {action_execution: record.execution.id, resulting_observation: observation.id});
                        }
                    }
                    for (const record of from.get(observation.id) ?? []) {
                        if (!history.actionExecution(record.execution.id)) {
                            apply("action_selected", record.execution);
                        }
                        if (record.executionResult !== null && history.actionExecution(record.execution.id)?.execution_result === null) {
                            apply("action_execution_reported", record.executionResult);
                        }
                    }
                }
                requireAsm(sequence.status === "running" || sequence.status === "finished", "invalid_evidence", "Unknown sequence status.");
                if (sequence.status === "finished" && history.testSequence(sequence.id)?.status !== "finished") {
                    apply("test_sequence_finished", {test_sequence: sequence.id, reason: sequence.reason ?? "Recorded sequence finished"});
                }
            }
            requireAsm(run.status === "running" || run.status === "finished", "invalid_evidence", "Unknown run status.");
            if (run.status === "finished" && history.testRun(run.id)?.status !== "finished") {
                apply("test_run_finished", {test_run: run.id, reason: run.reason ?? "Recorded run finished"});
            }
        }
        requireAsm(history.observations.length === evidence.observations.length &&
            history.testSequences.length === evidence.sequences.length &&
            history.actionExecutions.length === evidence.executions.length, "invalid_evidence", "Unresolved evidence records.");
        for (const record of evidence.executions) {
            const accepted = history.actionExecution(record.execution.id);
            requireAsm(accepted?.status === record.status &&
                same(accepted.execution_result, record.executionResult) &&
                accepted.resulting_observation === record.resultingObservation,
                "invalid_evidence", "Execution status differs from its lifecycle.");
        }
    }
}
