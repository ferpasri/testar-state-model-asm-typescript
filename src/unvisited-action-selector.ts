import type { AbstractModelEdge, ExecutionReference } from "testar-abstraction";
import { ActionSelector, type SelectorResult } from "./action-selector.js";
import { requireAsm } from "./errors.js";
import { compareText, compareReference, compareList, refKey } from "./data.js";
import type { AsmEntry, Ranking } from "./types.js";

/** Unvisited ASM tries a new action here, then navigates toward known unvisited actions. */
export class UnvisitedActionSelector extends ActionSelector {
    select(entry: AsmEntry): SelectorResult {
        const rankings = this.rankings(false, entry.name === "unvisited" && entry.unmatched_choices === "isolated");
        const eligible = rankings.filter(item => item.eligible);
        if (eligible.length === 0) {
            return {reason: "no_comparable_choices", rankings};
        }
        const local = eligible.filter(item => item.recorded_executions === 0);
        if (local.length > 0) {
            return {choice_id: this.choose(local).choice_id, reason: "local_unvisited_action", rankings};
        }
        return this.navigate(rankings);
    }

    private navigate(rankings: Ranking[]): SelectorResult {
        const unvisited = new Map<string, number>();
        for (const action of this.actions) {
            if (this.representatives.has(action.sourceNode) && action.availability.length > 0 &&
                action.executions.length === 0 && !action.ambiguous) {
                unvisited.set(action.sourceNode, (unvisited.get(action.sourceNode) ?? 0) + 1);
            }
        }
        if (unvisited.size === 0) {
            return {reason: "no_unvisited_actions", rankings};
        }
        const current = this.nodes.get(refKey(this.context.observation));
        type Edge = AbstractModelEdge & {representative: ExecutionReference};
        const adjacency = new Map<string, Edge[]>();
        const allowed = new Set(this.choiceActions.values());
        for (const edge of this.data.model.edges) {
            if (edge.kind !== "execution" || edge.executions.length === 0 ||
                (edge.source === current && !allowed.has(edge.abstractAction!))) {
                continue;
            }
            const edges = adjacency.get(edge.source) ?? [];
            edges.push({...edge, representative: [...edge.executions].sort(compareReference)[0]});
            adjacency.set(edge.source, edges);
        }
        type Route = {node: string | undefined; path: Edge[]; visited: Set<string | undefined>};
        const queue: Route[] = [{node: current, path: [], visited: new Set([current])}];
        const routes: Route[] = [];
        let shortest: number | undefined;
        let head = 0;
        // Breadth-first search follows completed transitions only, never observation-order links.
        while (head < queue.length) {
            requireAsm(head < 10000, "processing_limit", "Shortest route search exceeded 10000 alternatives.");
            const route = queue[head++];
            if (shortest !== undefined && route.path.length > shortest) {
                break;
            }
            if (route.node !== current && unvisited.has(route.node!)) {
                shortest = route.path.length;
                routes.push(route);
                continue;
            }
            for (const edge of adjacency.get(route.node!) ?? []) {
                if (!route.visited.has(edge.target)) {
                    requireAsm(queue.length < 10000, "processing_limit", "Shortest route search exceeded 10000 alternatives.");
                    queue.push({node: edge.target, path: [...route.path, edge], visited: new Set([...route.visited, edge.target])});
                }
            }
        }
        if (routes.length === 0) {
            return {reason: "no_reachable_unvisited_actions", rankings};
        }
        const most = Math.max(...routes.map(route => unvisited.get(route.node!)!));
        const targets = [...new Set(routes.filter(route => unvisited.get(route.node!) === most).map(route => route.node!))]
            .sort((a, b) => compareReference(this.representatives.get(a)!, this.representatives.get(b)!));
        const target = this.choose(targets);
        const paths = routes.filter(route => route.node === target).map(route => route.path)
            .sort((a, b) => compareList(a, b, (x, y) => compareReference(x.representative, y.representative)));
        const path = this.choose(paths);
        const choices = [...this.choiceActions].filter(([, action]) => action === path[0].abstractAction)
            .map(([id]) => id).sort(compareText);
        return {
            choice_id: this.choose(choices), reason: "navigate_to_unvisited_actions", rankings,
            navigation: {target_state: this.representatives.get(target)!, distance: path.length,
                unvisited_actions: most, supporting_executions: path.map(edge => edge.representative)},
        };
    }
}
