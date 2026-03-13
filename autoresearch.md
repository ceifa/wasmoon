# Autoresearch: reduce Wasmoon heapsort benchmark time

## Objective
Optimize the Wasmoon runtime path used by the plain heapsort benchmark: load the Lua module once, create a fresh state per iteration, load `bench/heapsort.lua`, execute it, and call the returned function. The goal is to reduce average runtime for this benchmark on the current machine.

## Metrics
- **Primary**: wasmoon_heapsort_avg_ms (ms, lower is better)
- **Secondary**: wasmoon_heapsort_stddev_ms, iterations, warmup

## How to Run
`./autoresearch.sh` — builds the project, runs a focused benchmark, and prints `METRIC name=value` lines.

## Files in Scope
- `src/module.ts` — JS↔C binding wrappers and helper utilities around `ccall`
- `src/thread.ts` — stack operations, string loading, execution helpers
- `src/global.ts` — state creation and global helpers
- `src/engine.ts` — engine setup and state lifecycle
- `src/type-extensions/*.ts` — only if profiling suggests extension registration / value conversion overhead matters
- `bench/heapsort.lua` — benchmark workload, read-only unless a benchmark bug is found
- `autoresearch.sh` — benchmark driver
- `autoresearch.md` — session state and findings
- `autoresearch.ideas.md` — backlog for promising ideas

## Off Limits
- `lua/` C sources and wasm build artifacts for this session
- public API behavior changes unless benchmark gains are substantial and correctness is preserved
- new dependencies

## Constraints
- Keep benchmark semantics the same: fresh state, load heapsort script, execute returned function
- No new dependencies
- Prefer simple changes with measurable wins
- Avoid benchmark-only cheats that would not help real users

## What's Been Tried
- Initial setup only. No experiments yet.
