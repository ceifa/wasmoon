# Rethinking async in wasmoon

Design proposal, 2026-09-05. Everything marked *measured* below was run against the current
`dist/` (Node 26.7, V8 14.6) or against a one-off wasm build; the scripts are in `experiments/`.

## TL;DR

The current model has one primitive, "yield the Lua coroutine and let a JS loop look at what was
yielded", and everything (awaiting, time slicing, cancellation, callbacks) is squeezed through it.
That is why awaits fail inside `table.sort`, `gsub`, `promise:next(luaFn)` and every JS→Lua
callback, why top-level `coroutine.yield` values are silently dropped, why a parked run cannot be
aborted or timed out, and why a loop of awaits starves the event loop.

Proposal, in two layers:

1. **A real scheduler in JS, engine-agnostic.** Every asynchronous entry point becomes a *run*:
   one Lua coroutine, one JS promise, one cancellation scope. The scheduler owns parking and
   resuming, uses an explicit yield protocol instead of sniffing the last yielded value, resumes
   in microtasks with a starvation guard, can cancel a parked run, and lets JS→Lua callbacks
   return a promise when the Lua side suspends. This fixes most of the list above with no wasm
   change and is required anyway as the fallback engine.
2. **JSPI as the primary engine where available.** With `-sSUPPORT_LONGJMP=wasm` (+47 bytes of
   wasm, -746 bytes of glue JS, and *measured* 30-45% faster `pcall`/`error`/yield paths on its
   own) the interpreter runs under `WebAssembly.promising`, and an await anywhere, including
   across C boundaries and inside coroutines nobody drives, simply suspends the wasm stack.
   *Measured*: a suspension costs 0.3-1.6 µs depending on the stack strategy versus 6 µs for
   today's coroutine round trip; CPU-bound code is unaffected; 1000 parked runs cost ~4 MB, the
   same as today. Two things make it work in this codebase: a C-side trampoline that calls a plain
   import first and a `Suspending` import only when suspension is allowed, and saving each run's
   slice of the linear-memory C stack across a suspension (without that, interleaved runs corrupt
   each other; both *measured*). See §6 for the full numbers.

JSPI is in Chrome/Edge 137+, Firefox 153+, Node 25+ (Node 24 only behind a flag) and not in
Safari, so the scheduler layer stays the contract and JSPI is a feature-detected accelerator with
identical observable semantics wherever both can express them.

---

## 1. How it works today

```
doString(code)                          Lua                              JS function `sleep`
  │ newAnchoredThread + load             │                                 │
  │ thread.run() ── lua_resume ────────► │ sleep(10):await()               │
  │                                      │  └► promise ext `await`:        │
  │                                      │     pendingAwaits[L] = {…}      │
  │                                      │     push(promise)               │
  │                                      │     lua_yieldk(L, 1, 0, k) ─────┼──► longjmp → JS exception
  │ ◄── LUA_YIELD, 1 value ──────────────┘                                 │    (EmscriptenEH, rethrown)
  │ getValue(-1); isPromise? await it                                      │
  │   else: setImmediate / setTimeout(0)                                   │
  │ lua_resume(L, 0) ──────────────────► │ continuation k:                 │
  │                                      │  result ready? push, return 1   │
  │                                      │  not ready?  lua_yieldk again   │
  │ ◄── LUA_OK ── getStackValues()       │                                 │
```

Relevant code: `Thread.run` (`src/thread.ts:158`), the promise extension
(`src/type-extensions/promise.ts`), `FunctionTypeExtension.getValue` which calls Lua from JS
with a synchronous `lua_pcallk` (`src/type-extensions/function.ts:191`), and the limit hook
(`src/thread.ts` `applyHook`/`checkYieldLimits`).

Properties of this model:

- The *only* way to park is `lua_yieldk` on the coroutine `run()` is driving. Anything that is
  not that coroutine, or has a C frame between it and the await, cannot park.
- The host decides what a yield *means* by looking at the last yielded value. Await and
  "cooperative time slice" share one channel; user yields have no channel at all.
- JS→Lua calls are always synchronous. The callback runs on a pooled thread under `lua_pcallk`
  and a yield is an error.
- Awaits inside a coroutine that Lua code resumes (not the host) work by *polling*: the
  continuation re-yields with zero values until the promise has settled, and the resumer has to
  `coroutine.yield()` to the host between attempts (see the README workaround).
- Limits are checked by the debug hook while Lua runs and by `run()` around yields only.

## 2. What is wrong (all *measured*, `experiments/current-behavior.mjs`)

| # | Behaviour | Result today |
|---|---|---|
| 1 | `coroutine.yield(io.stdout)` at top level of `doString` | throws `TypeError: the Lua type 'userdata' with metatable 'FILE*' has no JS representation`. `run()` calls `getValue(-1)` on whatever the script yielded. |
| 2 | `local a, b = coroutine.yield(1, 2)` at top level | `a`, `b` are nil. Values are popped and discarded, resume passes nothing back. |
| 3 | `:await()` inside a `table.sort` comparator or a `gsub` callback | `cannot await in a thread that cannot yield, use doString instead of doStringSync`. Wrong diagnosis: we *are* in `doString`, this is a C-call boundary. |
| 4 | `:await()` inside `promise:next(function() ... end)` | same error. The callback is entered from JS via `lua_pcallk`. |
| 5 | JS calls a Lua function that awaits (`state.get('f')(2)`) | same error. No way to get a promise back. |
| 6 | `while not flag() do Promise.resolve(1):await() end` with a 5 ms timer setting `flag` | 20 000 iterations, timer never fires. Resumes are microtasks with no macrotask boundary. |
| 7 | `sleep(300):await()` with `{ signal }` aborted at 10 ms, or `{ timeout: 10 }` | rejects after **301 ms**. Limits are only observed after the promise settles. |
| 8 | 200 bare `coroutine.yield()` round trips | 6 ms in Node. In browsers `setTimeout(0)` is clamped to 4 ms when nested, so the same script takes ~800 ms. |
| 9 | Cost of one await round trip on an already settled promise | ~6 µs (10k in 59 ms): two `lua_resume` calls, a longjmp through a JS exception, a Map lookup, a promise `then`. |
| 10 | Nested `coroutine.resume(co)` where `co` awaits | returns `true` immediately with the promise as its value; the caller must poll. Also `pendingAwaits` keeps the record until the state closes if `co` is never resumed again (documented leak, `promise.ts:141`). |

Things that do work and should keep working: awaits inside `pcall`, inside Lua metamethods
called from Lua (`__index` from Lua code is yieldable in 5.4+), inside Lua iterators, several
host-driven runs interleaving on one state, `Promise.all`, rejection → Lua error and back.

Smaller structural issues worth fixing while there:

- `pendingInterrupt` lives on the root thread and every `resume()` clears it, so two interleaved
  runs can clobber each other's interrupt (safe today only because hook → `lua_error` →
  `assertOk` never crosses an await).
- `stateToThread` allocates a fresh `Thread` for every callback made from a coroutine the JS side
  has not seen before.
- Every `lua_yieldk` from a C function longjmps, which under `SUPPORT_LONGJMP=emscripten` is a JS
  exception plus the `isEmscriptenUnwind` brand hack in `rolldown.config.ts`.

## 3. Constraints

- **Size and speed budget.** `glue.wasm` is 192,923 bytes after a long flag sweep; the JS bundle
  was cut to ~98 KB. Asyncify would roughly double the wasm and slow the interpreter by tens of
  percent, so it is out.
- **Targets.** `browserslist`: Chrome ≥134, Firefox ≥138, Safari ≥26; `engines`: Node ≥24. JSPI
  coverage today: Chrome/Edge 137+, Firefox 153+, Node 25+ by default (`--experimental-wasm-jspi`
  on Node 24), Safari none. Any design needs a non-JSPI path with the same API.
- **One wasm instance, many states, one linear-memory C stack.** Everything that suspends shares
  the 1 MB Emscripten stack. This is the one place JSPI needs help (section 5.4).
- **Lua's own rules stay.** A `lua_State` cannot be entered twice concurrently (*measured*: two
  promising `lua_pcallk` on the same thread → `memory access out of bounds`), so every run still
  needs its own coroutine, as `callByteCode` already does.

## 4. Options considered

**A. Asyncify.** Solves the C-boundary problem by rewriting the wasm. Rejected on size and speed,
and it still allows only one in-flight suspension per instance.

**B. Keep `lua_yieldk`, fix the scheduler.** No wasm change. Fixes 1, 2, 4, 5, 6, 7, 8, 10 and the
misleading message in 3. Does *not* fix 3 itself (C-call boundary) and cannot make an await inside
a Lua-resumed coroutine transparent. Needed regardless as the fallback.

**C. JSPI.** Fixes everything in the table including 3, and awaits inside Lua-resumed coroutines
become transparent (the resumer simply waits). *Measured* on a `-sSUPPORT_LONGJMP=wasm` build,
raw glue, Node 26 (`experiments/jspi-raw.mjs`):

| Measurement | Result |
|---|---|
| await inside `table.sort` comparator, `gsub` callback, `coroutine.wrap` body | all work |
| Lua `error()` after a suspension, `lua_error` from a suspended import | caught by `pcall` correctly |
| `coroutine.yield` alongside JSPI | works |
| Suspending import called while **not** under `promising` | traps `trying to suspend without WebAssembly.promising` **even when it does not return a promise** |
| Suspending import called with a JS `invoke_*` longjmp trampoline on the stack (today's build) | traps `trying to suspend JS frames` |
| 10k `lua_pcallk` round trips, sync vs `promising` | 17.2 ms vs 39.3 ms (+2.2 µs per entry) |
| 100k imports that never suspend, plain vs `Suspending` | 4.1 ms vs 13.1 ms (+0.09 µs per call) |
| 10k suspensions on an already settled promise | 2.6 ms (0.26 µs each; today 6 µs) |
| 200k-element `table.sort`, sync vs `promising` | 100 ms vs 91 ms (noise) |
| wasm size, `SUPPORT_LONGJMP=emscripten` → `wasm` | 192,923 → 192,970 bytes; glue JS 87,012 → 86,266 |
| 100k `pcall(f)` without error, same switch | 12.2 ms → 6.8 ms |
| 100k `pcall(error, "x")`, same switch | 136 ms → 87 ms |
| 100k Lua-only `coroutine.yield`/resume, same switch | 97 ms → 65 ms |
| 100k `lua_yieldk` / `lua_error` from a JS function, same switch | 115 → 83 ms / 145 → 103 ms |
| heapsort.lua, same switch | 13.4 ms → 13.5 ms |

Two concurrent runs on different states interleaving deep C recursion (`pcall` + `gsub` buffers)
across suspensions **corrupt each other** unless the linear-memory stack is managed: a Lua longjmp
escapes as a raw `WebAssembly.Exception`, then `C stack overflow`, then `memory access out of
bounds` (`experiments/jspi-stack.mjs`, unmanaged). With the management described in 5.4 the same
test passes every round. Pyodide documents the same problem and fix for CPython
(blog.pyodide.org, "Integrating JSPI with the WebAssembly C Runtime").

**Recommendation: B as the contract, C as the engine when present.** The visible API is defined
by B; C removes B's remaining limitations where the platform allows and is detected at load.

## 5. Proposed architecture

### 5.1 The run

```ts
/** One asynchronous entry into Lua. Owned by the scheduler, never exposed as is. */
interface Run {
    thread: Thread               // its own coroutine (lua_newthread), anchored in the registry
    limits: LuaThreadLimits      // deadline, budget, signal; replaces the root pendingInterrupt slot
    settle: Deferred<MultiReturn>
    parked?: Parked              // what it is waiting on, if anything
    onYield?: (values: MultiReturn) => unknown | Promise<unknown>
}
```

`doString`, `doFile`, `Thread.run` and (new) asynchronous Lua function calls all create a run.
Sync entry points (`doStringSync`, `call`, `runSync`) do not; they increment a module-wide
`syncDepth` counter for the duration of the call (see 5.3).

### 5.2 One suspender interface, two engines

```ts
interface Suspender {
    /** Called by the promise extension from inside a Lua→JS call. Must not return normally
     *  unless it has a value to hand back. */
    park(thread: Thread, promise: PromiseLike<unknown>): number   // returns a Lua result count
    /** Drives a run to completion. */
    drive(run: Run, argCount: number): Promise<MultiReturn>
}
```

**YieldSuspender (fallback, today's mechanism cleaned up).**

- `park`: refuses unless `lua_isyieldable`; records `{ promise }` on the run (or, for a coroutine
  Lua code is resuming, in an ephemeron-keyed registry table, see 5.6); yields **two** values:
  the module's await token (a lightuserdata the module owns, like `interruptToken`) and the
  promise. Continuation `k` is one shared function pointer as now.
- `drive`: `lua_resume` loop. On `LUA_YIELD`: if slot `-2` is the await token (pointer compare, no
  `getValue` on user values) → await the promise, resume; otherwise it is a **host yield** →
  hand `getStackValues` to `run.onYield`, resume with whatever it returns (awaited if a promise).
  Default `onYield` is "give the event loop a turn and resume with nothing", which is today's
  behaviour minus the discarded values bug.
- Resume happens in the promise's own microtask. A per-run counter forces a macrotask boundary
  after N consecutive microtask resumes (or after T ms of continuous running), which fixes #6
  without paying a macrotask per await.
- Macrotask = `scheduler.yield()` if present, else `MessageChannel` (no 4 ms clamp), else
  `setImmediate`/`setTimeout`. Fixes #8.

**JspiSuspender.**

- Enabled when `typeof WebAssembly.Suspending === 'function'` *and* the glue was built with
  `SUPPORT_LONGJMP=wasm`. `drive` calls `promising(lua_resume)`; host yields work exactly as
  above, so the run loop is shared.
- `park` never yields; it returns a marker that tells the C trampoline (5.3) to call the
  `Suspending` import, which returns the promise and lets the VM switch stacks.
- Nothing is recorded anywhere: the pending state *is* the suspended wasm stack. #10's leak and
  the polling protocol disappear, and an await inside a coroutine that Lua resumes just makes the
  resumer wait, which is what users expect. The README polling pattern keeps working unchanged
  (the loop observes the coroutine finishing).

### 5.3 The C trampoline, and when suspension is allowed

Today each JS function is a C closure whose C function is an `addFunction` trampoline
(`functionWrapper`). Two facts from the measurements shape the replacement: a `Suspending` import
traps whenever it is reached outside a `promising` call, and it traps if a JS frame sits between
it and the `promising` boundary. So the decision to suspend has to be taken *before* touching the
`Suspending` import, and from a wasm frame.

```c
/* src/native/wasmoon.c */
extern int wasmoon_call(lua_State *L);   /* plain import: runs the JS function */
extern int wasmoon_await(lua_State *L);  /* Suspending import: returns the stashed promise */

static int wasmoon_jsfunction(lua_State *L) {
    int n = wasmoon_call(L);              /* >= 0: results pushed; -1: a promise is pending */
    if (n == -1) n = wasmoon_await(L);    /* wasm frame → import, no JS in between */
    return n;
}
```

`wasmoon_call` is today's `functionWrapper` body plus the promise extension's `await`, and ends
with one decision:

| Situation | `wasmoon_call` does |
|---|---|
| result is not an await request | push results, return count (unchanged) |
| `:await()` and `syncDepth === 0` and JSPI engine | stash the promise, return -1 → VM suspends |
| `:await()` and `syncDepth > 0` (a sync entry point is on the JS stack) or no JSPI | `YieldSuspender.park` if `lua_isyieldable`, else the error, now worded "cannot await here: a synchronous call is on the stack" / "…across a C-call boundary" |

`syncDepth` is exact because resumptions only ever happen from an empty JS stack (promise
reactions are microtasks), and a sync entry point cannot yield to the event loop. The one edge, a
run *started* from inside a sync callback, degrades to the yield path, which is correct.

Both imports are provided through Emscripten's `instantiateWasm` hook so `wasmoon_await` can be
wrapped in `WebAssembly.Suspending` when available and be a plain never-called stub otherwise; no
`-sJSPI` flag, no Asyncify glue. `addFunction` stays for user-registered raw C functions and the
hook; the per-state trampoline pool becomes one C function with the JS reference in an upvalue,
as today.

### 5.4 Linear-memory stack management (JSPI only)

JSPI switches the wasm stack, not the `__stack_pointer` global or the memory it points at. When a
resumed run returns through a frame (which restores `__stack_pointer` to that frame's entry) and
then pushes new frames, it writes over any other suspended run's frames below. *Measured*: a Lua
longjmp escapes as a raw `WebAssembly.Exception`, then `C stack overflow`, then `memory access out
of bounds`; the pointer also drifts down 224 bytes per interleaving. Pyodide hit and documented the
same thing for CPython.

Two strategies were measured (`experiments/jspi-modes.mjs`); both pass the interleaving stress and
the nested-start case (a run started from inside another run's JS callback):

| | **copy** (recommended) | **region** |
|---|---|---|
| Mechanism | on suspension copy `[sp, mainSP)` to a JS buffer and set SP back; before resuming copy it back and restore `sp`. The promising wrapper restores its own entry SP after the call returns. | `malloc` a 256 KB region per promising run, set SP to its top; the suspension saves/restores SP. |
| Suspension on a settled promise | 1.6 µs | 0.5 µs |
| Suspension 30 `pcall` levels deep (~30 KB of C frames) | 3.9 µs | 0.5 µs |
| 1000 parked runs | rss +4.4 MB, wasm memory +0 | rss +224 MB, wasm memory +247 MB |
| Bytes copied per suspension in the stress test | 23 KB avg | 0 |

Copy is Pyodide's "simplest fix" and is what the numbers favour: parked runs are the common
steady state for anything event driven, and a suspension is still 4x cheaper than today's round
trip in the worst case measured. Worst-case slice size is bounded by Lua's own C-call limit:
*measured* 108 KB (nested `gsub` to the limit), 45 KB (nested `pcall`), 22 KB (`table.sort`
comparators). Follow-ups if the copy ever shows up in a profile: copy `[sp, entrySP)` instead of
up to the main top (needs the run's entry SP, i.e. run tracking), and pool the buffers by size
class instead of `slice`.

Why copying back stale bytes over another run's range is safe: a resume only ever happens from an
empty JS stack, at which point every other run is either finished or suspended and therefore
holding its own copy, which it restores on its own resume. Sync entry points push below whatever
the current SP is and finish before anything can resume.

### 5.5 JS→Lua calls become sync-or-promise

`getValue` for a function returns a callable that:

1. acquires a coroutine (pool as today) and runs the function with `lua_resume`, not `lua_pcallk`;
2. if it finishes, returns the value synchronously (unchanged fast path, no promise allocated);
3. if it yields with the await protocol, hands the coroutine to the scheduler as a run and
   **returns a Promise**; a host yield inside a callback is an error, as now.

Under JSPI the same callable still uses `lua_resume` synchronously (a `promising` entry would
cost +2.2 µs on the hot interop path and would *always* return a promise). An await inside it
takes the yield path because `syncDepth > 0`, so `promise:next(function() sleep():await() end)`,
`array:map(luaFn)` with an awaiting `luaFn`, and `await state.get('handler')(req)` all work in
both engines. The footgun ("sometimes a promise") is real but is the only shape that composes with
JS APIs that accept callbacks; `decorate(fn, { call: 'sync' })` can opt a function out (throw on
suspension) and `{ call: 'async' }` can force a promise.

### 5.6 Cancellation and limits while parked

- A run's `signal`/`timeout` is raced against every park. On abort the run is resumed with the
  interrupt token pushed and `lua_error` (the hook's existing mechanism), so `__close`/to-be-closed
  variables run, `pcall` in the script cannot swallow it (token check in `assertOk` as today), and
  the coroutine ends in a defined state. Same code path in both engines; in JSPI the resume is
  "return from the `Suspending` import, then `lua_error`", never a foreign JS exception thrown
  into wasm. The eventual settlement of the abandoned promise is ignored. Fixes #7.
- `pendingInterrupt` moves onto the run. Nested coroutines inherit the hook and report to the
  run that owns them (they already inherit the hook function pointer).
- Fallback engine, coroutine resumed by Lua code (not a run): the pending record is keyed in a
  registry ephemeron table `{ [thread] = box }` whose box `__gc` drops the JS record, so an
  abandoned awaiting coroutine is collected with the thread instead of at `state.close()`.

### 5.7 Lua-side surface

- `promise:await()` unchanged.
- `Promise.async(fn, ...)` (inject mode) starts `fn` as its own run and returns a promise. This is
  the README workaround implemented in JS with no polling, and the recommended way to fan out.
  Works identically in both engines.
- Under the fallback engine, `coroutine.resume(co)` where `co` awaits keeps today's semantics
  (yields the promise up; resumer polls). Under JSPI the resumer waits. Documented as "the
  fallback is a subset".

## 6. Performance and memory

Everything here is *measured* (Node 26.7, `experiments/perf-dist.mjs`, `perf-raw.mjs`,
`jspi-modes.mjs`), best of 5.

**Hot paths that must not regress**

| Path | Today | Proposed | Why |
|---|---|---|---|
| Lua→JS function call that does not await | 0.04 µs import | same + one C call | the plain import runs first; the `Suspending` import is only reached when suspension was decided |
| JS→Lua callback (100k calls, pooled thread) | `lua_pcallk` 14.6 ms; through `getValue` wrapper 16.4 ms | `lua_resume` 14.8 ms | same cost; a promise is only allocated when the callback actually suspends |
| CPU-bound Lua (heapsort.lua) | 13.4 ms | 13.5 ms under wasm EH; 91 vs 100 ms for a 200k `table.sort` under `promising` | no Asyncify instrumentation, JSPI is free while not suspending |
| `pcall`, `error`, coroutine yield/resume | see §4 | 30-45% faster | wasm EH replaces the `invoke_*` JS trampolines and JS exceptions |

**Per-run and per-await costs**

| | Today | Fallback engine | JSPI engine |
|---|---|---|---|
| Starting a run (`doString('return 1')`) | 4.1 µs | ~same (a `Run` object and a deferred on top) | +2.2 µs for the `promising` entry (39.3 vs 17.2 ms per 10k) |
| Await of a settled promise | 6 µs (two resumes, a JS-exception longjmp, Map lookup) | ~4 µs (wasm-EH longjmp, no Map, starvation counter) | 1.6 µs copy / 0.5 µs region |
| Await 30 C levels deep | error today | error | 3.9 µs copy / 0.5 µs region |
| Bare `coroutine.yield()` round trip | 30 µs Node, ~4 ms browsers | ~µs (`MessageChannel`), no clamp | same loop |
| Resume 1000 parked runs | 2.5 ms | ~same | 0.9 ms |

**Memory**

| | Today | Fallback engine | JSPI engine (copy) | JSPI engine (region) |
|---|---|---|---|---|
| 1000 concurrently parked runs | rss +3.8 MB (1.9 MB JS heap; a Lua thread and a pending record each) | ~same, minus the leaked records | rss +4.4 MB (V8 suspended stack ~4-5 KB each, saved slice a few KB) | rss +224 MB |
| Per parked await, steady state | pending record until resume or `state.close()` | pending record until resume, cancel, or the thread's `__gc` | the saved stack slice, freed on resume | the region, freed on completion |
| Abandoned awaiting coroutine | leaks until `state.close()` | collected with the thread (ephemeron) | nothing to leak | nothing to leak |
| Extra bundle | | ~1-2 KB (scheduler) | + a few hundred bytes (wrapper, copy) | |

Take-aways: the redesign does not touch the interop or interpreter hot paths; awaits get 1.5-10x
cheaper depending on engine; wasm EH is a straight speed win for error handling; and the copy
strategy keeps memory flat in the number of parked runs, which the region strategy does not.

## 7. API changes (JS)

| Today | Proposed | Notes |
|---|---|---|
| `doString/doFile` → Promise | unchanged | now a run; abortable while parked |
| `doStringSync/doFileSync` | unchanged | `syncDepth++` around the call |
| `thread.run(argCount, options)` | `+ options.onYield(values) → resume values \| Promise` | top-level `coroutine.yield` becomes a usable host channel; default keeps time-slicing behaviour |
| `thread.runSync`, `thread.call` | unchanged | |
| Lua function from `getValue`: sync, throws on yield | sync result **or** Promise when it suspends | `decorate(fn, { call: 'sync' \| 'async' })` to pin |
| `LuaRunOptions.signal` "observed after the promise settles" | interrupts a parked run immediately | doc change + behaviour |
| `Promise.create/all/resolve` (inject) | `+ Promise.async` | |
| `LuaRuntime.load()` | `+ options.async?: 'auto' \| 'jspi' \| 'yield'` and `runtime.engine` | `'auto'` default; `'yield'` for tests and for diffing behaviour |
| error `cannot await in a thread that cannot yield, use doString instead of doStringSync` | split into "synchronous call on the stack" and "C-call boundary (use the JSPI engine or Promise.async)" | |

Breaking: (a) callbacks can now return promises; (b) top-level yield values are no longer
discarded; (c) `signal`/`timeout` fire while parked. All three are today's bugs rather than
features, but (a) deserves a major version note.

## 8. Build changes

- `-sSUPPORT_LONGJMP=wasm` in `utils/build-wasm.sh`. Required for JSPI (no `invoke_*` JS frames),
  +47 bytes wasm, smaller glue, and a native longjmp instead of a JS exception on every
  `lua_yieldk`/`lua_error` from a C function. `isEmscriptenUnwind` becomes
  `err instanceof WebAssembly.Exception` and the `EmscriptenEH` brand plugin in
  `rolldown.config.ts` goes away. All target browsers support wasm EH.
- `src/native/wasmoon.c` gains `wasmoon_jsfunction` and the two imports; the imports are
  resolved in `Module.instantiateWasm`.
- No `-sJSPI`, no `-sASYNCIFY`. Feature detection at load, both engines in the bundle (the JSPI
  part is a few hundred bytes).

## 9. Phasing

1. **Scheduler rewrite (fallback engine only).** `Run`, await token protocol, `onYield`, macrotask
   policy, starvation guard, cancellation while parked, per-run interrupt slot, ephemeron for
   nested awaits, sync-or-promise callbacks. Ship behind no flag; this is a bugfix release with
   one semver-major note. Tests: everything in §2 becomes a test.
2. **`SUPPORT_LONGJMP=wasm` + `wasmoon_jsfunction` in C.** Behaviour-neutral on its own; measure
   heapsort and interop benches (memory says the current `-Oz` set wins on heapsort, this flag
   was size-neutral in that sweep and was not speed-tested).
3. **JspiSuspender.** `promising(lua_resume)`, stack slice copy (§5.4), `syncDepth` gate,
   `Suspending` import via `instantiateWasm`. Gate on the §6 numbers: interop bench unchanged,
   heapsort unchanged, 1000 parked runs under 10 MB. Run the whole test suite under `async: 'jspi'` and
   `async: 'yield'` on Node ≥25 and browsers; add the interleaving stress from
   `experiments/jspi-stack.mjs` as a test.
4. **Docs.** Replace the README "Async/Await" workaround with `Promise.async`, describe the two
   engines and the one semantic difference (§5.7).

## 10. Risks and open questions

- **Copy cost on deep stacks.** 4 µs at 30 C levels; a pathological script awaiting inside deeply
  nested `gsub` callbacks pays ~10 µs per await. Acceptable, and the `[sp, entrySP)` follow-up
  halves it.
- **`stackRestore` interaction with Emscripten internals.** `stringToUTF8OnStack`/`withCString`
  use the C stack; they must not straddle a park. Today `pushValue` never does, keep it that way.
- **JSPI and the debug hook.** Untested: a hook that fires and `lua_error`s while another run is
  suspended. Should be fine (same thread only), needs a test.
- **Firefox/Safari fallback fidelity.** The C-call-boundary case stays an error on Safari and
  Firefox <153. Message must point at `Promise.async` or restructuring.
- **Same-function two trampolines?** Not needed: one C function, decision at call time. Verify
  `lua_pushcclosure` with a real C function (not `addFunction`) does not change `getReferenceBox`
  upvalue handling.
- **Name of `Promise.async` / `decorate` options.** Bikeshed.

## Appendix: experiments

All in `experiments/`, run from the repo root.

- `current-behavior.mjs`: the table in §2 against `dist/`.
- `build-wasm-eh.sh`: the build script with `-sSUPPORT_LONGJMP=wasm`, output to `/out`; run via
  `podman run --rm -v "$PWD:/wasmoon" -v "$OUT:/out" docker.io/emscripten/emsdk /out/build-wasm-eh.sh`.
- `jspi-raw.mjs <glue.js>`: JSPI feature and timing matrix (§4 C) against the raw glue.
- `jspi-sp.mjs <glue.js>`: prints `__stack_pointer` around suspensions (shows the drift).
- `jspi-stack.mjs <glue.js> [mitigate]`: the interleaving stress; fails without `mitigate`, passes
  with it.
- `jspi-modes.mjs <glue.js> <none|region|copy>`: the two stack strategies of §5.4 against the
  stress, the nested start, suspension timings and memory for 1000 parked runs. Run with
  `--expose-gc`.
- `perf-raw.mjs <glue.js> [jspi]`: heapsort, `pcall`/`error`/yield throughput, worst-case C stack
  depth; with `jspi`, memory and entry costs. Run on both glues to get the wasm EH comparison.
- `perf-dist.mjs`: today's callback call cost and parked-run memory against `dist/`.
