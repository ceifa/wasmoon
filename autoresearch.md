# Autoresearch: reduce published output size

## Objective
Reduce the published output size of `wasmoon` while preserving runtime behavior and keeping runtime performance at least flat on a representative Lua workload.

The main user-visible size target is the npm package payload produced by `npm pack --dry-run`, since that reflects what downstream users actually download. Because `wasmoon` ships both JS and WASM assets, changes that shrink either `dist/index.js`, `dist/glue.wasm`, or other published files are in scope.

## Metrics
- **Primary**: `tarball_kb` (kb, lower is better)
- **Secondary**: `unpacked_kb`, `index_js_kb`, `glue_wasm_kb`, `heapsort_ms`, `build_ms`

## How to Run
`./autoresearch.sh` — builds the package, measures `npm pack --json --dry-run`, and runs a small Lua heapsort benchmark. It prints `METRIC name=value` lines.

## Files in Scope
- `package.json` — published file list and package metadata
- `rolldown.config.ts` — bundle output settings
- `src/index.ts` — package entry surface
- `src/module.ts` — initialization path; likely source of bundle-size opportunities
- `src/**/*.ts` — implementation files if API-preserving size reductions are possible
- `utils/**` — build helpers if needed for output shaping
- `autoresearch.sh` — benchmark harness
- `autoresearch.checks.sh` — correctness checks
- `autoresearch.md` / `autoresearch.ideas.md` — session notes

## Off Limits
- Public API semantics
- Lua VM behavior / correctness
- Benchmark cheating (must measure real published output)
- Adding new runtime dependencies

## Constraints
- `npm test` must pass for kept changes
- No regressions in the small heapsort runtime benchmark
- Keep resource usage the same or better; prefer deletions and publish-time exclusions over added complexity
- Generated `dist/**` files may change as a consequence of build changes, but source-of-truth edits should stay in source/config files

## What's Been Tried
- Baseline not yet recorded.
- First likely win to validate: avoid publishing source maps if they are not required for runtime and dominate package size.
- Also inspect whether browser/node split code or export surface can reduce shipped JS without changing behavior.
