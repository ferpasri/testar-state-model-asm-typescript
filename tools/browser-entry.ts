import { parseJson } from "testar-evidence";
import { AsmRun } from "../src/index.js";

/** Exercise native browser imports, WebCrypto, model construction, and selection. */
export async function check(serialized: string): Promise<{choice: string; revision: number}> {
    const input: any = parseJson(serialized);
    const initial = input.evidence_sets[input.initial_evidence];
    const run = await AsmRun.create(input.configuration, initial.sources, initial.selected_runs);
    await run.setContext(input.steps.find((step: any) => step.operation === "set_context").context);
    const selection = await run.select();
    if (selection.result_type !== "selected") {
        throw new Error("Expected a browser selection: " + selection.reason);
    }
    await run.cancel();
    if ((await run.select()).reason !== "cancelled") {
        throw new Error("Browser cancellation failed.");
    }
    return {choice: selection.choice_id, revision: run.asmDataRevision};
}
