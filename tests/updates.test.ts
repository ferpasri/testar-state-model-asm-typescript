import { expect, test, vi } from "vitest";
import { ReconstructedEvidence, copyJson } from "testar-evidence";
import { constructAbstractModel, runKey, type AnalysisSource } from "testar-abstraction";
import { AsmRun, type SourceSnapshot } from "../src/index.js";
import { fixture } from "./support.js";
import { compareText } from "../src/data.js";

function analysis(source: SourceSnapshot): AnalysisSource {
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

test("accept each widget tree once while an execution progresses from selected to completed", async () => {
    const input = fixture("execution-lifecycle");
    const apply = vi.spyOn(ReconstructedEvidence.prototype, "apply");
    try {
        const initial = copyJson(input.evidence_sets.initial) as typeof input.evidence_sets.initial;
        const run = await AsmRun.create(input.configuration, initial.sources, initial.selected_runs);
        const before = run.model;
        for (const name of ["pending", "returned", "completed"]) {
            const update = copyJson(input.evidence_sets[name]) as typeof initial;
            await run.updateEvidence(name, update.sources, update.selected_runs);
            const batch = await constructAbstractModel(update.sources.map(analysis), input.configuration.abstraction,
                update.selected_runs.map((item: {source: string; run: string}) => runKey(item.source, item.run)));
            expect(run.model).toEqual(batch.model);
        }
        // Old form o1 and result form o2 are each accepted once, not once per update.
        const observations = apply.mock.calls.filter(([event]) => (event as any).event.event_type === "observation_recorded");
        expect(observations.map(([event]) => (event as any).event.data.id)).toEqual(["o1", "o2"]);
        expect(before.counts.completedExecutions).toBe(0);
        expect(run.model.counts.completedExecutions).toBe(1);
    } finally {
        apply.mockRestore();
    }
});

test("a report rejected after model construction does not affect the next valid report", async () => {
    const input = fixture("execution-lifecycle");
    const initial = input.evidence_sets.initial;
    const run = await AsmRun.create(input.configuration, initial.sources, initial.selected_runs, {chooseIndex: () => 0});
    await run.setContext(input.steps[0].context);
    const selected = await run.select();
    expect(selected.result_type).toBe("selected");
    const execution = {source: "live", run: "run", execution: "e1"};
    await run.beginExecution(selected as any, execution);
    const before = run.model;

    // This is valid evidence for the second button, but the ASM selected the first.
    const wrong = input.evidence_sets.completed;
    wrong.sources[0].evidence.executions[0].execution.action_description = "a2";
    wrong.sources[0].evidence.executions[0].execution.target_widget = "two";
    await expect(run.reportExecution(execution, "wrong-button", wrong.sources, wrong.selected_runs))
        .rejects.toMatchObject({code: "execution_mismatch"});
    expect(run.model).toBe(before);
    expect(run.asmDataRevision).toBe(0);

    const correct = fixture("execution-lifecycle").evidence_sets.completed;
    await run.reportExecution(execution, "correct-button", correct.sources, correct.selected_runs);
    expect(run.model.counts.completedExecutions).toBe(1);
    expect(run.asmDataRevision).toBe(1);
    await run.setContext(input.steps.find((step: any) => step.operation === "set_context" && step.context.context_id === "c2").context);
    expect(await run.select()).toMatchObject({choice_id: "choice-2", reason: "local_unvisited_action"});
});

test("an invalid new observation cannot contaminate the next evidence update", async () => {
    const input = fixture("execution-lifecycle");
    const initial = input.evidence_sets.initial;
    const run = await AsmRun.create(input.configuration, initial.sources, initial.selected_runs);
    const before = run.model;
    const invalid = input.evidence_sets.completed;
    invalid.sources[0].evidence.observations[1].available_actions[0].action_description = "missing";
    await expect(run.updateEvidence("bad-widget-binding", invalid.sources, invalid.selected_runs)).rejects.toMatchObject({code: "invalid_evidence"});
    expect(run.model).toBe(before);
    const correct = fixture("execution-lifecycle").evidence_sets.completed;
    await run.updateEvidence("valid-after-rejection", correct.sources, correct.selected_runs);
    expect(run.model.counts.observations).toBe(2);
    expect(run.model.counts.completedExecutions).toBe(1);
});

test("unchanged caller fingerprints do not hide added observations or executions", async () => {
    const input = fixture("execution-lifecycle");
    const initial = input.evidence_sets.initial;
    const run = await AsmRun.create(input.configuration, initial.sources, initial.selected_runs);
    const completed = input.evidence_sets.completed;
    completed.sources[0].fingerprint = initial.sources[0].fingerprint;
    await run.updateEvidence("same-fingerprint", completed.sources, completed.selected_runs);
    expect(run.model.counts.observations).toBe(2);
    expect(run.model.counts.completedExecutions).toBe(1);
});

test("freezing only an observation does not conceal later changes to its widget properties", async () => {
    const input = fixture("execution-lifecycle");
    const initial = input.evidence_sets.initial;
    Object.freeze(initial.sources[0].evidence.observations[0]);
    const run = await AsmRun.create(input.configuration, initial.sources, initial.selected_runs);
    initial.sources[0].evidence.observations[0].recorded_state.widgets[0].properties["ui.name"] = "Changed";
    await expect(run.updateEvidence("nested-mutation", initial.sources, initial.selected_runs))
        .rejects.toMatchObject({code: "conflicting_evidence"});
});

test("expanding selected runs adds their already known states to the model", async () => {
    const input = fixture("execution-lifecycle");
    const initial = input.evidence_sets.initial;
    const other = fixture("execution-lifecycle").evidence_sets.initial.sources[0];
    other.id = "other";
    other.fingerprint = "other-trace";
    const sources = [...initial.sources, other];
    const run = await AsmRun.create(input.configuration, sources, initial.selected_runs);
    expect(run.model.counts.observations).toBe(1);
    await run.updateEvidence("include-other", sources, [...initial.selected_runs, {source: "other", run: "run"}]);
    expect(run.model.counts.observations).toBe(2);
});

test("source fingerprint changes are applied together even when two values are exchanged", async () => {
    const input = fixture("execution-lifecycle");
    const initial = input.evidence_sets.initial;
    const other = fixture("execution-lifecycle").evidence_sets.initial.sources[0];
    other.id = "other";
    other.fingerprint = "other-trace";
    const sources = [...initial.sources, other];
    const selected = [...initial.selected_runs, {source: "other", run: "run"}];
    const run = await AsmRun.create(input.configuration, sources, selected);
    const original = sources[0].fingerprint;
    sources[0].fingerprint = other.fingerprint;
    other.fingerprint = original;
    await run.updateEvidence("exchange-fingerprints", sources, selected);
    const batch = await constructAbstractModel(sources.map(analysis), input.configuration.abstraction,
        selected.map((item: {source: string; run: string}) => runKey(item.source, item.run)));
    expect(run.model).toEqual(batch.model);
});

test("allocation-free text comparison retains Unicode code-point ordering", () => {
    const values = ["", "a", "aa", "\uffff", "\u{10000}", "\u{10000}a", "\u{10ffff}", "\ud800", "\udfff"];
    function reference(left: string, right: string): number {
        const a = Array.from(left, value => value.codePointAt(0)!);
        const b = Array.from(right, value => value.codePointAt(0)!);
        for (let index = 0; index < Math.min(a.length, b.length); index++) {
            if (a[index] !== b[index]) {
                return a[index] - b[index];
            }
        }
        return a.length - b.length;
    }
    for (const left of values) {
        for (const right of values) {
            expect(Math.sign(compareText(left, right))).toBe(Math.sign(reference(left, right)));
        }
    }
});
