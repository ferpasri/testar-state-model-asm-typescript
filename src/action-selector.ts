import type { AbstractAction, EvidenceReference, ExecutionReference } from "testar-abstraction";
import { requireAsm } from "./errors.js";
import { compareText, compareReference, key, refKey } from "./data.js";
import { STATUSES, StateModelData } from "./state-model-data.js";
import type { AsmEntry, ChooseIndex, ObservationContext, Ranking, Navigation } from "./types.js";

export interface SelectorResult {
    choice_id?: string;
    reason: string;
    rankings: Ranking[];
    navigation?: Navigation;
}

/** Match current executable choices to recorded abstract actions before choosing one. */
export abstract class ActionSelector {
    protected actions: AbstractAction[];
    protected nodes = new Map<string, string>();
    protected representatives = new Map<string, EvidenceReference>();
    protected choiceActions = new Map<string, string>();
    private availability = new Map<string, AbstractAction[]>();

    constructor(protected data: StateModelData, protected context: ObservationContext, private chooseIndex: ChooseIndex) {
        this.actions = data.model.actionEvidence!.actions;
        for (const node of data.model.nodes) {
            this.representatives.set(node.id, [...node.members].sort(compareReference)[0]);
            if (node.groupId) {
                for (const member of node.members) {
                    this.nodes.set(refKey(member), node.id);
                }
            }
        }
        for (const action of this.actions) {
            const bindings = new Set(action.availability.map(item => {
                const reference = item.reference;
                return key(refKey(reference), reference.actionDescription, reference.targetWidget);
            }));
            for (const binding of bindings) {
                const matches = this.availability.get(binding) ?? [];
                matches.push(action);
                this.availability.set(binding, matches);
            }
        }
    }

    /** A single alternative consumes no randomness; ties use the caller's provider. */
    protected choose<T>(items: T[]): T {
        requireAsm(items.length > 0, "processing_limit", "No selection alternatives.");
        const index = items.length === 1 ? 0 : this.chooseIndex(items.length);
        requireAsm(Number.isInteger(index) && index >= 0 && index < items.length,
            "invalid_configuration", "The random provider returned an invalid index.");
        return items[index];
    }

    protected rankings(includeUnmatched = false, isolated = false): Ranking[] {
        return [...this.context.choices].sort((a, b) => compareText(a.choice_id, b.choice_id)).map(choice => {
            const reference = this.context.observation;
            const matches = this.availability.get(key(refKey(reference), choice.action_description, choice.target_widget)) ?? [];
            const action = matches.length === 1 ? matches[0] : undefined;
            const match: Ranking["match"] = !this.nodes.has(refKey(reference)) ? "unmatched_state" :
                !action ? "unmatched_action" : action.ambiguous ? "ambiguous_action" : "matched";
            let scope: Ranking["count_scope"] = null;
            let references: ExecutionReference[] = [];
            if (match === "matched") {
                this.choiceActions.set(choice.choice_id, action!.id);
                scope = "abstract_action";
                references = action!.executions.map(record => record.reference);
            } else if (isolated) {
                scope = "recorded_binding";
                for (const [id, record] of this.data.executions) {
                    const execution = record.execution;
                    if (id === key(reference.source, reference.run, execution.id) &&
                        execution.source_observation === reference.observation &&
                        execution.action_description === choice.action_description && execution.target_widget === choice.target_widget) {
                        references.push({source: reference.source, run: reference.run, execution: execution.id});
                    }
                }
            }
            references.sort(compareReference);
            const counts = scope ? Object.fromEntries(STATUSES.map(status => [status, 0])) as NonNullable<Ranking["status_counts"]> : null;
            if (counts) {
                for (const item of references) {
                    counts[this.data.executions.get(refKey(item))!.status]++;
                }
            }
            return {
                choice_id: choice.choice_id, match, eligible: scope !== null || includeUnmatched,
                count_scope: scope, recorded_executions: scope ? references.length : null,
                status_counts: counts, supporting_executions: references,
            };
        });
    }

    abstract select(entry: AsmEntry): SelectorResult;
}

