import { expect, test } from "vitest";
import { AsmRun, type ExplorationDriver } from "../src/index.js";
import { createExample, fixture } from "./support.js";

test("the driver records an action and its result before the ASM reaches its action limit", async () => {
    // The source starts with a form offering two buttons. Executing the first button
    // records e1 and a resulting observation. The ASM does not write these facts:
    // the driver's completed snapshot is evidence supplied by the recording layer.
    const input = fixture("execution-lifecycle");
    input.configuration.total_action_limit = 1;
    const run = await AsmRun.create(input.configuration, [], [], {chooseIndex: () => 0});
    let observations = 0;
    let executions = 0;
    const driver: ExplorationDriver = {
        observe() {
            observations++;
            return {...input.evidence_sets.initial, context: input.steps[0].context};
        },
        prepareExecution() {
            return {source: "live", run: "run", execution: "e1"};
        },
        execute() {
            executions++;
            return input.evidence_sets.completed;
        },
    };
    expect(await run.explore(driver)).toMatchObject({reason: "action_limit_reached"});
    expect(observations).toBe(1);
    expect(executions).toBe(1);
    expect(run.model.counts.completedExecutions).toBe(1);
});

test("a driver exception retains the outstanding execution for reporting", async () => {
    const {input, run, random} = await createExample("execution-lifecycle");
    random.set([{size: 2, index: 0}]);
    const error = new Error("Browser disconnected after invocation");
    await expect(run.explore({
        observe: () => ({...input.evidence_sets.initial, context: input.steps[0].context}),
        prepareExecution: () => ({source: "live", run: "run", execution: "e1"}),
        execute: () => { throw error; },
    })).rejects.toBe(error);
    expect(await run.select()).toMatchObject({reason: "execution_in_progress"});
    await run.reportExecution({source: "live", run: "run", execution: "e1"}, "completed-after-error",
        input.evidence_sets.completed.sources, input.evidence_sets.completed.selected_runs);
    expect(run.model.counts.completedExecutions).toBe(1);
});

test("a never-invoked operation can refresh without consuming the action limit", async () => {
    const input = fixture("execution-lifecycle");
    input.configuration.total_action_limit = 1;
    const run = await AsmRun.create(input.configuration, [], [], {chooseIndex: () => 0});
    expect(await run.explore({
        observe: () => ({...input.evidence_sets.initial, context: input.steps[0].context}),
        prepareExecution: () => ({source: "live", run: "run", execution: "e1"}),
        execute: () => ({...input.evidence_sets.initial, invoked: false}),
    }, {maxCycles: 1})).toMatchObject({reason: "cycle_limit_reached"});
    expect(run.model.counts.completedExecutions).toBe(0);
});

test("updates are serialized and immutable facts cannot be rewritten with an unchanged fingerprint", async () => {
    const {input, run} = await createExample("execution-lifecycle");
    const initial = input.evidence_sets.initial;
    const updates = await Promise.all([
        run.updateEvidence("same-1", initial.sources, initial.selected_runs),
        run.updateEvidence("same-2", initial.sources, initial.selected_runs),
    ]);
    expect(updates.map(result => result.changed)).toEqual([false, false]);
    const before = run.model;
    initial.sources[0].evidence.observations[0].recorded_state.properties["changed"] = true;
    await expect(run.updateEvidence("changed", initial.sources, initial.selected_runs))
        .rejects.toMatchObject({code: "conflicting_evidence"});
    expect(run.model).toBe(before);
    expect(run.asmDataRevision).toBe(0);
    expect(() => run.model.nodes.push(run.model.nodes[0])).toThrow();
});
