import { test } from "vitest";
import { cases, executeCase, reverseRecords } from "./support.js";

for (const name of cases.names) {
    for (const reversed of [false, true]) {
        test(name + (reversed ? " / reversed record order" : ""), async () => {
            const input = cases.read(name, "input");
            await executeCase(reversed ? reverseRecords(input) : input, cases.read(name, "expected"));
        });
    }
}
