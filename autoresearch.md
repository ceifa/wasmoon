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
- Baseline started around 220.5 kB tarball, then re-baselined at 168.5 kB after a local WASM artifact drift changed the package payload used by the harness.
- Big win: stop publishing sourcemaps and make the `files` list explicit in `package.json`.
- Keep only declaration files reachable from the public API; internal unreferenced `.d.ts` files were safe to drop.
- `tsconfig.json` with `removeComments: true` shrank published declarations further.
- `rolldown -c --minify` is a strong win for `dist/index.js` size; extra rolldown flags tried so far were neutral or unsupported in this version.
- Compacting `bin/wasmoon` yields small but real tarball wins with no benchmark regressions.
- Publishing a trimmed runtime-only `package.json` via `prepack`/`postpack` is a valid win.
- WASM rebuild experiments are currently noisy/non-comparable in this environment because rebuilding changes `glue.wasm` far more than the checked-in artifact; avoid spending much more loop time there unless the toolchain baseline is reset intentionally.
- Next likely areas: publish-time README reduction, further declaration-surface cleanup that preserves the public API, or JS bundle reductions in `src/module.ts` / entry exports.
