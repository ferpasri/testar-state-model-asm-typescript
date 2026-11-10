import type {
    AbstractionRules, AnalysisSource, EvidenceReference, ExecutionReference,
    Observation, ActionDescription, RecordedRun, RecordedSequence, RecordedExecution,
} from "testar-abstraction";

export type { EvidenceReference, ExecutionReference, AnalysisSource, AbstractionRules };
export type AsmEntry =
    | { name: "random"; action_limit: number }
    | { name: "unvisited"; action_limit: number; unmatched_choices?: "exclude" | "isolated" };
export interface AsmConfiguration {
    abstraction: AbstractionRules;
    asms: AsmEntry[];
    total_action_limit?: number;
}
/** Array-based snapshots share the same records as the abstraction library's map-based sources. */
export interface SourceSnapshot {
    id: string;
    label: string;
    fingerprint: string;
    evidence: {
        runs: RecordedRun[];
        sequences: RecordedSequence[];
        observations: Observation[];
        actions: ActionDescription[];
        executions: RecordedExecution[];
    };
}
export type SourceInput = SourceSnapshot | AnalysisSource;
export interface RunReference { source: string; run: string }
export interface EvidenceSnapshot { sources: readonly SourceInput[]; selected_runs: readonly RunReference[] }
export interface Choice { choice_id: string; action_description: string; target_widget: string | null }
export interface ObservationContext {
    context_id: string;
    observation: EvidenceReference;
    choices: Choice[];
}
export type ExecutionStatus = RecordedExecution["status"];
export interface Ranking {
    choice_id: string;
    match: "matched" | "unmatched_state" | "unmatched_action" | "ambiguous_action";
    eligible: boolean;
    count_scope: "abstract_action" | "recorded_binding" | null;
    recorded_executions: number | null;
    status_counts: Record<ExecutionStatus, number> | null;
    supporting_executions: ExecutionReference[];
}
export interface Navigation {
    target_state: EvidenceReference;
    distance: number;
    unvisited_actions: number;
    supporting_executions: ExecutionReference[];
}
export interface SelectionToken {
    context_id: string;
    asm_data_revision: number;
    choice_id: string;
}
export interface SelectedAction extends SelectionToken {
    result_type: "selected";
    asm_index: number;
    reason: "local_unvisited_action" | "navigate_to_unvisited_actions" | "random_action";
    message: string;
    rankings: Ranking[];
    navigation?: Navigation;
}
export interface NoAction {
    result_type: "no_action";
    asm_data_revision: number;
    context_id: string | null;
    asm_index: number;
    reason: string;
    message: string;
    rankings: Ranking[];
}
export type SelectionResult = SelectedAction | NoAction;
export type ChooseIndex = (size: number) => number;
export interface OperationResult {
    result_type: string;
    asm_data_revision: number;
    context_id?: string;
    execution?: ExecutionReference;
    changed?: boolean;
    status?: ExecutionStatus;
}
