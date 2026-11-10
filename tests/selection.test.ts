import { describe, expect, test } from "vitest";
import { createExample } from "./support.js";

describe("Unvisited action selection", () => {
    test("try a new action here before navigating to another state", async () => {
        // Historical traces connect page A to B and C. The current visit to A also
        // reports new-a, which has never been executed. State abstraction matches
        // this visit to historical A; action abstraction matches the two known links.
        const {input, run} = await createExample("local-unvisited-before-navigation");
        await run.setContext(input.steps[0].context);
        const selected = await run.select();
        expect(selected.result_type).toBe("selected");
        expect(selected).toMatchObject({choice_id: "new-a", reason: "local_unvisited_action"});
        expect(selected.rankings.find(item => item.choice_id === "new-a")?.recorded_executions).toBe(0);
    });

    test("navigate to the nearest state with an unvisited action", async () => {
        // A's eligible actions have already been tried. Completed historical transitions
        // lead to B in one step and a more distant destination in two steps.
        // The ASM returns to-b now, not the unvisited action waiting at the destination.
        const {input, run} = await createExample("navigation-nearest-state");
        await run.setContext(input.steps[0].context);
        expect(await run.select()).toMatchObject({
            choice_id: "to-b", reason: "navigate_to_unvisited_actions",
            navigation: {distance: 1, unvisited_actions: 1,
                supporting_executions: [{source: "history", run: "run", execution: "e1"}]},
        });
    });

    test("prefer more unvisited actions when destinations are equally near", async () => {
        // Both B and C are one transition away. C has two distinct unvisited
        // abstract actions and B has one, so no random tie-break is needed.
        const {input, run} = await createExample("navigation-most-unvisited-actions");
        await run.setContext(input.steps[0].context);
        expect(await run.select()).toMatchObject({
            choice_id: "to-c", navigation: {distance: 1, unvisited_actions: 2},
        });
    });
});

test("Random ASM draws among current choices and reuses its decision", async () => {
    // The fixture supplies two current buttons. An injected draw chooses index 1
    // after sorting their choice IDs. Asking twice must not draw or execute twice.
    const {input, run, random} = await createExample("random-current-choices");
    await run.setContext(input.steps[0].context);
    random.set([{size: 2, index: 1}]);
    const selected = await run.select();
    expect(selected).toMatchObject({choice_id: "choice-2", reason: "random_action"});
    expect(await run.select()).toBe(selected);
    expect(random.draws).toEqual([]);
    expect(run.asmDataRevision).toBe(0);
});
