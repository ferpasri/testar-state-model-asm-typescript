# TESTAR State Model ASM for TypeScript

Select GUI actions using a state model built from concrete test evidence and abstraction rules. The library provides Random and Unvisited ASMs, execution coordination, and switching between ASMs.

## Install

~~~shell
npm install github:ferpasri/testar-state-model-asm-typescript#v0.3.1
~~~

Applications import `testar-state-model-asm`. The package runs in browsers and Node.js. Browser applications use a bundler and a secure context, such as HTTPS or localhost, for WebCrypto.

## Use

~~~typescript
import { AsmRun } from "testar-state-model-asm";

const run = await AsmRun.create(configuration, sources, selectedRuns);
await run.setContext({
    context_id: "current-choices",
    observation: { source: "trace", run: "run", observation: "observation-1" },
    choices: [
        { choice_id: "submit", action_description: "click-submit", target_widget: "submit-button" },
    ],
});
const selection = await run.select();
~~~

Configuration supplies abstraction rules with state and action comparisons and an ordered `asms` list. For example, `[{name: "unvisited", action_limit: 20}, {name: "random", action_limit: 5}]` switches between trying new actions and random selection. An optional `total_action_limit` limits the whole run.

Sources come from validated, reconstructed evidence. The abstraction library's `evidenceSource()` or `EvidenceInputBridge` prepares compatible sources. Selection returns one supplied choice; the exploration driver retains the executable browser objects.

The self-contained [example](examples/select-action.ts) records a form with two buttons, constructs its model, and requests a selection. The [library specification](docs/SPEC.md) explains reporting and the driver contract.

## Development

Requires Node.js 24 or later.

~~~shell
npm ci
npm run prepare:conformance
npm run check
npm run example
~~~

Shared cases are downloaded from the published release recorded in [compatibility.json](compatibility.json). The tests verify their file digests and run every case with both original and reversed record order.

To verify browser use:

~~~shell
npx playwright install chromium
npm run check:browser
~~~

The shared [ASM specification](https://github.com/ferpasri/testar-state-model-asm-specs) defines selection behavior. Package versions and dependencies are declared in `package.json`. Remaining work is tracked in [TODO](TODO.md).
