# Library specification

## Responsibilities

The evidence library records and validates concrete facts. The abstraction library groups matching states and actions. This ASM library uses that model to select actions and coordinate exploration.

| Component | Responsibility |
| --- | --- |
| `AsmRun` | Accept evidence, manage the current observation, select actions, enforce limits, and coordinate execution reports. |
| `StateModelData` | Own accepted source records, validate source lifecycle, and construct the abstract model. |
| `ActionSelector` | Match current choices to abstract actions and explain their execution counts. |
| `RandomActionSelector` | Choose uniformly among current eligible choices. |
| `UnvisitedActionSelector` | Prefer local unvisited actions, then a shortest route toward known unvisited actions. |
| `ExplorationDriver` | Derive and filter actions, record observations and outcomes through an evidence adapter, and execute the selected operation. |

## Inputs and results

`await AsmRun.create(configuration, sources, selectedRuns, options?)` creates a run at ASM data revision zero. Empty evidence is allowed. Abstraction rules remain fixed during that run and include an `actions` section.

Sources accept either the abstraction library's map-based `AnalysisSource` or equivalent array-based `SourceSnapshot` records. Selected runs use `{source, run}`. Supplied source identifiers qualify references across traces.

`setContext(context)` supplies the latest observation in an active run and sequence, together with eligible choices from its recorded available-action list. Context identifiers identify that exact observation and choice list.

`select()` returns a selected choice or a no-action reason. Rankings explain matching, execution counts, statuses, and supporting records. Failed executions count as visited. Unknown correspondence retains an unknown count. Repeated selection requests reuse the same decision until evidence or context changes.

The Unvisited ASM tries a new action in the current state first. Otherwise it follows completed directed transitions toward the nearest state with unvisited actions. Equal distances favor more distinct unvisited actions; remaining ties use unbiased random selection. Observation-order links retain their explanatory role in the model.

## Execution and evidence updates

Call `beginExecution(selection, executionReference)` immediately before invocation. Then record the action and its outcome through the evidence adapter and call `reportExecution(reference, updateId, sources, selectedRuns)`.

Pending reports keep the execution outstanding. Terminal reports allow the next action and retire its observation context. An invoked execution consumes one action count, including errors; repeated reports count once. `reportNotInvoked(reference)` clears an operation that never started and requires a fresh context.

`updateEvidence(updateId, sources, selectedRuns)` accepts full snapshots for supplied sources. Omitted sources remain accepted; the selected-run list retains the previous scope. Existing immutable records and accepted results remain unchanged. Equivalent retries leave the revision unchanged.

Calls are serialized through a per-run promise queue. Incoming records are independently copied and frozen; unchanged accepted records and their content digests are reused. Changed source lifecycles and candidate models are checked before installation. Model construction uses the abstraction library's combined preview-and-model operation. Selection itself neither reconstructs history nor rebuilds the model.

`run.model` returns an immutable model snapshot. Earlier snapshots remain valid after updates. Errors expose an `AsmError.code` and leave accepted state unchanged. `cancel()` stops further selection and invocation while allowing final execution reports.

## Driver-controlled exploration

`await run.explore(driver, {maxCycles?})` repeats:

1. `observe()`: derive eligible actions, record their state, and return its context, sources, and selected runs.
2. Select an action and call `prepareExecution(selection)` to check applicability and allocate an execution reference. Return null to refresh the observation.
3. Begin execution, then call `execute(selection, reference)`. Return updated evidence and optionally `invoked: false` for an operation never invoked.
4. Accept the report and continue until cancellation, an action limit, a no-action result, or the cycle limit.

A driver exception propagates and retains an already outstanding execution for later reporting. The cycle limit bounds retries when applicability repeatedly changes.

The shared [contract](https://github.com/ferpasri/testar-state-model-asm-specs/blob/main/docs/contract.md) defines reasons, reference ordering, lifecycle rules, and error codes. `options.chooseIndex(size)` can supply deterministic draws for tests; the production default uses WebCrypto rejection sampling.
