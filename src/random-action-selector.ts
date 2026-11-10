import { ActionSelector, type SelectorResult } from "./action-selector.js";

/** Random ASM gives every currently eligible executable choice the same chance. */
export class RandomActionSelector extends ActionSelector {
    select(): SelectorResult {
        const rankings = this.rankings(true);
        return {choice_id: this.choose(rankings).choice_id, reason: "random_action", rankings};
    }
}

