# Autoresearch: optimize compiled Lua/wasm runtime for Wasmoon heapsort

## Objective
Optimize the runtime performance of the compiled Lua WebAssembly build used by Wasmoon on the focused heapsort benchmark. The workload is: build the wasm, bundle the JS bridge, load the Lua module once, create a fresh state per iteration, load `bench/heapsort.lua`, execute it, and call the returned function. The goal is to reduce benchmark runtime without cheating by changing benchmark semantics.

## Metrics
- **Primary**: wasmoon_heapsort_avg_ms (ms, lower is better)
- **Secondary**: wasmoon_heapsort_stddev_ms, wasm_build_seconds, glue_wasm_kb, iterations, warmup

## How to Run
`./autoresearch.sh` — rebuilds the wasm/runtime, rebuilds JS, runs the focused benchmark, and prints `METRIC name=value` lines.

## Files in Scope
- `utils/build-wasm.sh` — emcc flags, exported symbols, runtime settings, allocator, optimization knobs
- `utils/build-wasm.js` — wasm build launcher / Docker fallback
- `lua/*.c` / `lua/*.h` — Lua runtime implementation, only for broadly justifiable runtime improvements
- `rolldown.config.ts` — only if wasm packaging/bundling materially affects runtime loading behavior
- `src/module.ts` / `src/*.ts` — only if needed to adapt to safe wasm-build changes
- `autoresearch.sh` — benchmark driver for this session
- `autoresearch.md` — session context
- `autoresearch.ideas.md` — deferred ideas

## Off Limits
- Benchmark workload semantics in `bench/heapsort.lua`
- Fake optimizations that skip work, cache results across iterations, or otherwise cheat the benchmark
- New dependencies

## Constraints
- Keep benchmark semantics the same: fresh state, load heapsort script, execute returned function
- No benchmark-only cheating or semantic shortcuts
- Prefer broadly useful speedups over highly workload-specific tricks
- Avoid changing public API behavior unless clearly safe

## What's Been Tried
- Previous JS-glue-focused session got the benchmark from `14.775872ms` to `11.751988ms` by reducing JS↔wasm overhead (`lua_callk`/`lua_pcallk` raw exports and direct exported `luaL_loadstring`).
- Profiling after those wins showed the remaining time is dominated by Lua execution itself, so wasm/compiler/runtime changes are now the most promising path.
- Deferred ideas from the prior session: batched wasm-side helpers and build-level optimization tuning. This session focuses on the latter first.
