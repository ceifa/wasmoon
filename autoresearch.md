# Autoresearch: reduce wasm size without hurting features, startup, runtime, or performance

## Objective
Reduce the size of the generated WebAssembly artifact (`build/glue.wasm`, copied to `dist/glue.wasm`) for wasmoon while preserving user-visible functionality and avoiding regressions in startup latency and representative runtime performance.

The working assumption is that build-time/link-time/compiler flags and packaging details are the safest levers. Feature removal is out of scope.

## Metrics
- **Primary**: `wasm_bytes` (bytes, lower is better)
- **Secondary**: `wasm_gzip_bytes`, `startup_ms`, `create_state_ms`, `heapsort_ms`, `build_ms`

## How to Run
`./autoresearch.sh` — rebuilds the wasm and JS bundle, then prints `METRIC name=number` lines.

## Files in Scope
- `utils/build-wasm.sh` — emcc flags and exported/runtime settings for the wasm build.
- `utils/build-wasm.js` — wasm build entrypoint used by npm scripts.
- `rolldown.config.ts` — packaging/copy behavior for emitted artifacts.
- `src/module.ts` — loader/runtime expectations that may constrain size-oriented build changes.
- `package.json` — build/test script coordination if needed.
- `autoresearch.sh` — benchmark harness for this optimization loop.
- `autoresearch.checks.sh` — correctness backpressure checks.
- `autoresearch.ideas.md` — backlog for promising but deferred ideas.

## Off Limits
- Public API behavior.
- Lua language/features exposed by the current build.
- Test fixtures and benchmark workloads, unless a harness bug must be fixed.
- Dependency additions.

## Constraints
- No feature regressions.
- `npm test` must keep passing.
- Do not accept a wasm size win if startup or representative runtime performance degrades materially.
- Prefer simpler compiler/linker/build changes over invasive code changes.

## What's Been Tried
- Session initialized. Baseline pending.
- Initial hypothesis: investigate emcc optimization profile (`-O3` vs size-oriented options), LTO, and Emscripten feature toggles before touching runtime code.
