import { expect } from "vitest";
import { AsmRun, AsmError, type AsmConfiguration } from "../src/index.js";
import { parseJson, stringifyJson } from "testar-evidence";

function copy<T>(value: T): T {
    return parseJson(stringifyJson(value)) as T;
}
import { loadConformance } from "../tools/conformance.ts";

export const cases = await loadConformance();
export function fixture(name: string) {
    return copy(cases.read(name, "input"));
}

export class RandomChoices {
    draws: Array<{size: number; index: number}> = [];
    set(draws: typeof this.draws): void {
        expect(this.draws).toEqual([]);
        this.draws = copy(draws);
    }
    choose = (size: number): number => {
        const draw = this.draws.shift();
        expect(draw, "Unexpected random draw").toBeDefined();
        expect(size).toBe(draw!.size);
        return draw!.index;
    };
}

export async function createExample(name: string) {
    const input = fixture(name);
    const initial = input.evidence_sets[input.initial_evidence];
    const random = new RandomChoices();
    const run = await AsmRun.create(input.configuration, initial.sources, initial.selected_runs, {chooseIndex: random.choose});
    return {input, run, random};
}

export async function executeCase(input: any, expected: any) {
    const original = copy(input);
    const random = new RandomChoices();
    const initial = input.evidence_sets[input.initial_evidence];
    let run: AsmRun;
    try {
        run = await AsmRun.create(input.configuration as AsmConfiguration, initial.sources, initial.selected_runs, {chooseIndex: random.choose});
    } catch (error) {
        expect(error).toBeInstanceOf(AsmError);
        expect({result_type: "error", asm_data_revision: 0, code: (error as AsmError).code}).toEqual(expected.initialization);
        return;
    }
    expect(expected.initialization).toEqual({result_type: "ready", asm_data_revision: 0});
    expect(input.steps.length).toBe(expected.responses.length);
    for (const [index, step] of input.steps.entries()) {
        random.set(step.random_choices ?? []);
        const evidence = input.evidence_sets[step.evidence_set];
        const before = run.model;
        const revision = run.asmDataRevision;
        let actual: any;
        try {
            switch (step.operation) {
                case "set_context": actual = await run.setContext(step.context); break;
                case "select": actual = await run.select(); break;
                case "begin_execution": actual = await run.beginExecution(step.selection, step.execution); break;
                case "report_execution": actual = await run.reportExecution(step.execution, step.update_id, evidence.sources, evidence.selected_runs); break;
                case "report_not_invoked": actual = await run.reportNotInvoked(step.execution); break;
                case "update_evidence": actual = await run.updateEvidence(step.update_id, evidence.sources, evidence.selected_runs); break;
                case "cancel": actual = await run.cancel(); break;
                default: throw new Error("Unknown shared operation: " + step.operation);
            }
            if (actual.result_type === "selected" || actual.result_type === "no_action") {
                expect(actual.message).toBeTruthy();
                const {message, ...structured} = actual;
                actual = structured;
            }
        } catch (error) {
            if (!(error instanceof AsmError)) {
                throw error;
            }
            actual = {result_type: "error", asm_data_revision: run.asmDataRevision, code: error.code};
            expect(run.model).toBe(before);
            expect(run.asmDataRevision).toBe(revision);
        }
        expect(actual, "Step " + index + ": " + step.operation).toEqual(expected.responses[index]);
        expect(random.draws).toEqual([]);
    }
    expect(input).toEqual(original);
}

export function reverseRecords(input: any): any {
    const reversed = copy(input);
    for (const evidence of Object.values(reversed.evidence_sets) as any[]) {
        evidence.sources.reverse();
        evidence.selected_runs.reverse();
        for (const source of evidence.sources) {
            for (const records of Object.values(source.evidence) as any[][]) {
                records.reverse();
            }
        }
    }
    for (const step of reversed.steps) {
        if (step.operation === "set_context") {
            step.context.choices.reverse();
        }
    }
    return reversed;
}
