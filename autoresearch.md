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
- For the rebuilt-from-scratch wasm session, default release build (`-O3`) baseline was `12.639066ms`, `7.585s` wasm build time, `277.404kb` wasm.
- Best wasm-build improvement so far: changing release build from `-O3` to `-O2` improved runtime to `11.794092ms`, while also reducing build time to `6.413s` and wasm size to `274.129kb`.
- Cross-checking outside the primary metric suggests some overfitting risk: on an exploratory numeric-heavy script `-O2` slightly beat `-O3`, but on an exploratory string-heavy script `-O3` beat `-O2`. So `-O2` is a strong win for the heapsort/numeric path, not yet a universally proven default.
- Discarded build-flag experiments: `-flto`, `-Os`, `-O1`, `-DNDEBUG`, `-fno-exceptions`/unwind stripping, `-fno-inline-functions`, `INITIAL_MEMORY=32MB`, `SUPPORT_LONGJMP=wasm`, and fixed 64MB memory without growth. All regressed runtime, and some hurt size/build time or semantics.
- Discarded runtime/source experiments: disabling Lua VM jump tables, adding no-continuation C helpers for `lua_call`/`lua_pcall`, adding likely() hints to array fast paths, and reordering `luaH_fastseti` fast-path checks. All regressed on the benchmark.
- Deferred ideas from the prior session: batched wasm-side helpers and build-level optimization tuning. Build-level tuning found a real win (`-O2`), but the remaining promising paths now look more invasive and should be validated against more than one workload to avoid overfitting.
