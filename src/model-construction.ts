import { IncrementalAbstraction, runKey, type AnalysisSource, type EvidenceChanges } from "testar-abstraction";
import { requireAsm } from "./errors.js";
import { same } from "./data.js";
import type { StateModelData } from "./state-model-data.js";
import type { SourceSnapshot } from "./types.js";

function analysisSource(source: SourceSnapshot): AnalysisSource {
    return {
        ...source,
        evidence: {
            runs: new Map(source.evidence.runs.map(record => [record.id, record])),
            sequences: new Map(source.evidence.sequences.map(record => [record.id, record])),
            observations: new Map(source.evidence.observations.map(record => [record.id, record])),
            actions: new Map(source.evidence.actions.map(record => [record.id, record])),
            executions: new Map(source.evidence.executions.map(record => [record.execution.id, record])),
        },
    };
}

function changes(source: SourceSnapshot, before?: SourceSnapshot): EvidenceChanges {
    function changed<T>(records: T[], previous: T[] | undefined, id: (record: T) => string): T[] {
        const old = new Map((previous ?? []).map(record => [id(record), record]));
        return records.filter(record => old.get(id(record)) !== record);
    }
    return {
        runs: changed(source.evidence.runs, before?.evidence.runs, record => record.id),
        sequences: changed(source.evidence.sequences, before?.evidence.sequences, record => record.id),
        observations: changed(source.evidence.observations, before?.evidence.observations, record => record.id),
        actions: changed(source.evidence.actions, before?.evidence.actions, record => record.id),
        executions: changed(source.evidence.executions, before?.evidence.executions, record => record.execution.id),
    };
}

/** Retain widget indexes and abstraction projections across accepted evidence updates. */
export class ModelConstruction {
    #engine?: IncrementalAbstraction;
    #builtFor?: StateModelData;

    async construct(data: StateModelData, previous: StateModelData | undefined, rules: ConstructorParameters<typeof IncrementalAbstraction>[0]) {
        const fingerprints = new Set<string>();
        for (const source of data.sources.values()) {
            requireAsm(!fingerprints.has(source.fingerprint), "invalid_evidence", "Each source must have a unique fingerprint.");
            fingerprints.add(source.fingerprint);
        }
        // IncrementalAbstraction uses fingerprints to order updates. Reset when a caller
        // supplies changed content with the same fingerprint, or expands the selected scope.
        const reset = !this.#engine || this.#builtFor !== previous ||
            !same(previous?.selectedRuns, data.selectedRuns) ||
            [...data.sources.values()].some(source => {
                const before = previous?.sources.get(source.id);
                return before && source !== before && source.fingerprint === before.fingerprint ||
                    [...(previous?.sources.values() ?? [])].some(old => old.id !== source.id && old.fingerprint === source.fingerprint);
            });
        if (reset) {
            this.#engine = new IncrementalAbstraction(rules, data.selectedRuns.map(item => runKey(item.source, item.run)));
        }
        // If construction or later ASM reporting rejects this candidate, the next update
        // starts from accepted records rather than retaining its private working index.
        this.#builtFor = undefined;
        for (const source of data.sources.values()) {
            const before = reset ? undefined : previous?.sources.get(source.id);
            if (source === before) {
                continue;
            }
            this.#engine!.update({
                source: analysisSource(source), previousFingerprint: before?.fingerprint ?? null, changes: changes(source, before),
            });
        }
        const constructed = await this.#engine!.construct();
        this.#builtFor = data;
        return constructed.model;
    }
}
