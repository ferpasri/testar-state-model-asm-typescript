/** A complete in-memory example: the page has two buttons and neither has been tried. */
import { ReconstructedEvidence, evidenceEvent } from "testar-evidence";
import { evidenceSource } from "testar-abstraction";
import { AsmRun } from "../dist/index.js";

const evidence = new ReconstructedEvidence({schema_version: 3, evidence_id: "example-trace"});
evidence.apply(evidenceEvent("run-start", "test_run_started", {
    id: "run", producer: "example", source_run: "example-run", properties: {},
}));
evidence.apply(evidenceEvent("sequence-start", "test_sequence_started", {
    id: "sequence", test_run: "run", sequence_index: 1, source_sequence: "example-sequence", properties: {},
}));
for (const id of ["submit", "cancel"]) {
    evidence.apply(evidenceEvent("describe-" + id, "action_described", {
        id, action_type: "click", properties: {},
    }));
}
evidence.apply(evidenceEvent("observe-form", "observation_recorded", {
    id: "form-1", test_sequence: "sequence", observation_index: 1, timestamp_micros: 1,
    recorded_state: {
        id: "state-1", properties: {"ui.title": "Application form"}, capture: "complete",
        widgets: ["submit", "cancel"].map(id => ({id, parent: null, properties: {"ui.name": id}})),
    },
    available_action_scope: "eligible",
    available_actions: ["submit", "cancel"].map(id => ({action_description: id, target_widget: id})),
    artifacts: [],
}));

// The evidence library records facts; abstraction groups states and actions; the ASM selects.
const source = evidenceSource(evidence, {id: "current", label: "Example trace"});
const run = await AsmRun.create({
    abstraction: {
        version: 1, name: "Page title and button name",
        state: [{name: "title", keys: ["ui.title"], required: true}], capture: "same",
        actions: {target: [{name: "name", keys: ["ui.name"], required: true}]},
    },
    asms: [{name: "unvisited", action_limit: 20}],
}, [source], [{source: "current", run: "run"}]);

await run.setContext({
    context_id: "form-choices-1",
    observation: {source: "current", run: "run", observation: "form-1"},
    choices: ["submit", "cancel"].map(id => ({choice_id: id, action_description: id, target_widget: id})),
});
const selection = await run.select();
console.log(selection);

// The driver would now check applicability, beginExecution(), execute and record the action,
// then reportExecution() with the updated evidence. Selection alone records no GUI execution.
