import { requireAsm } from "./errors.js";
import { key } from "./data.js";
import type { AsmRun } from "./run.js";
import type { EvidenceSnapshot, ExecutionReference, ObservationContext, SelectedAction } from "./types.js";

export interface ObservationUpdate extends EvidenceSnapshot { context: ObservationContext }
export interface ExecutionUpdate extends EvidenceSnapshot { invoked?: boolean }
/** The driver derives and filters actions, records evidence, and operates the testing technology. */
export interface ExplorationDriver {
    observe(): ObservationUpdate | Promise<ObservationUpdate>;
    prepareExecution(selection: SelectedAction): ExecutionReference | null | Promise<ExecutionReference | null>;
    execute(selection: SelectedAction, execution: ExecutionReference): ExecutionUpdate | Promise<ExecutionUpdate>;
}

/** Run the exploration cycle; unexpected driver errors retain the outstanding execution. */
export async function explore(run: AsmRun, driver: ExplorationDriver, {maxCycles = 1000}: {maxCycles?: number} = {}) {
    requireAsm(Number.isSafeInteger(maxCycles) && maxCycles > 0, "invalid_configuration", "maxCycles must be positive.");
    const prefix = globalThis.crypto.randomUUID();
    function scope(update: EvidenceSnapshot) {
        const combined = new Map(run.selectedRuns.map(reference => [key(reference.source, reference.run), reference]));
        for (const reference of update.selected_runs) {
            combined.set(key(reference.source, reference.run), reference);
        }
        return [...combined.values()];
    }
    for (let cycle = 0; cycle < maxCycles; cycle++) {
        const stopped = await run.explorationStop();
        if (stopped) {
            return stopped;
        }
        const observation = await driver.observe();
        await run.updateEvidence(prefix + ":observe:" + cycle, observation.sources, scope(observation));
        await run.setContext(observation.context);
        const selection = await run.select();
        if (selection.result_type === "no_action") {
            return selection;
        }
        const execution = await driver.prepareExecution(selection);
        if (execution === null) {
            continue;
        }
        await run.beginExecution(selection, execution);
        const report = await driver.execute(selection, execution);
        if (report.invoked === false) {
            await run.reportNotInvoked(execution);
            continue;
        }
        const response = await run.reportExecution(execution, prefix + ":execute:" + cycle, report.sources, scope(report));
        if (response.status === "awaiting_execution_result" || response.status === "awaiting_resulting_observation") {
            return run.select();
        }
    }
    return await run.explorationStop() ?? {
        result_type: "exploration_stopped", reason: "cycle_limit_reached",
        message: "The exploration cycle limit was reached.",
    };
}
