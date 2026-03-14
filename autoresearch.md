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
- Baseline: release build with `-O3` produced `wasm_bytes=284062`, `wasm_gzip_bytes=121522`, `startup_ms=4.489`, `create_state_ms=0.546`, `heapsort_ms=15.168`.
- `-O3 -flto` was a dead end: wasm grew sharply to `375922` bytes with no compensating runtime gain.
- Switching the release wasm build from `-O3` to `-Oz` was a strong win: `wasm_bytes=198273` and `wasm_gzip_bytes=95031`, while startup improved and representative runtime stayed effectively flat in the current harness.
- Adding `-fno-inline-functions` on top of `-Oz` produced another small win: `wasm_bytes=197352`, `wasm_gzip_bytes=95007`, with startup and heapsort still within noise in the current harness.
- A structurally different follow-up also paid off: running Binaryen `wasm-opt --all-features -Oz` as an explicit post-link pass reduced the kept build further to `wasm_bytes=197058`, `wasm_gzip_bytes=94893`, while checks passed and secondary metrics stayed acceptable.
- Refining that post-link step to `wasm-opt --all-features -Oz --gufa-optimizing` shaved off a bit more, reaching `wasm_bytes=196984`, `wasm_gzip_bytes=94796`, again with checks passing and secondary metrics staying acceptable.
- `-Os` was re-checked after the inlining change and remained clearly worse than `-Oz`.
- Additional post-link Binaryen refinements (strip metadata sections; duplicate-function/merge-similar/vacuum passes) did not improve on the kept Binaryen result.
- Most small compiler toggles tried after the `-Oz` switch (`ASSERTIONS=0`, visibility/vectorization/constant-merging/auto-library toggles) were neutral on wasm size.
- Next likely levers: only larger-scope decisions, especially whether the very broad exported Lua C API surface is all contractual, or whether packaging can diverge by environment without hurting users.
