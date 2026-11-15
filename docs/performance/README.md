# Performance measurements

2026-09-07, Node 26.7.0, baseline commit `55c7d96`.

The table push path now creates its registry anchor without retrieving the table
again, initializes tables without a helper closure, and pushes known string keys
directly. Cycles and shared references still use the same registry anchors.

Build the baseline and preserve its dist directory, then build the candidate. Run:

```sh
node docs/performance/table-copy.mjs /absolute/baseline/dist/index.js /absolute/candidate/dist/index.js
```

The harness alternates baseline/candidate order, discards six warmup rounds and
compares medians from eighteen measured rounds. Two runs of the final change:

| Input                                          | Median time reduction |
| ---------------------------------------------- | --------------------- |
| Empty object, 20,000 pushes                    | 3.1–3.9%              |
| Three-field object, 20,000 pushes              | 4.9–5.8%              |
| Array of 2,000 three-field objects, 100 pushes | 4.8–4.9%              |

These are local microbenchmarks, not a whole-library speedup claim.

The emitted index.js shrank from 114,958 to 114,949 bytes; the sum of individually
gzipped published dist files decreased by 5 bytes. Other emitted files were unchanged.

With `memory: { trace: true }`, GC stopped, and ten pushes of the nested array,
both versions reported 19,265 bytes before, 2,762,186 after, and 44,499 after a full
collection. Both Wasm heaps were 17,891,328 bytes. The change adds no retained JS
data structures and removes a per-table closure; JS heap allocation was not profiled.

Validation: 391 tests passed, formatting/lint passed, and `git diff --check` passed.
The full tests require browser server and child-process access outside the sandbox.

## Array reads and Lua calls

Sequence classification now runs in C, using the same ordered integer-key walk and
empty-table rule. This eliminates per-key Wasm crossings without allocating a
cache or temporary table. The helper uses public Lua APIs and leaves the stack
unchanged. Its raw export is used directly, avoiding a second binding on LuaModule.

The Lua function wrapper now uses the result count returned by `lua_resume`
instead of calling `lua_gettop` again. No-result calls still return null, and
multiple-result calls still return only the first value.

```sh
node docs/performance/read-table.mjs /absolute/baseline/dist /absolute/candidate/dist
node docs/performance/call-lua.mjs /absolute/baseline/dist/index.js /absolute/candidate/dist/index.js
node --expose-gc docs/performance/retained-memory.mjs /absolute/candidate/dist/index.js
```

The isolated classification comparison uses a baseline already containing the
table-push and result-count changes. Two final runs measured 18.6% and 20.4% less
time reading flat 2,000-element arrays. Nested-table reads changed by 0.4–2.1%;
object-table reads ranged from effectively unchanged to 1.1% slower, within the
observed timing variation. The result-count change measured about 2–3% less time
for 100,000 Lua calls with zero, one, or multiple results.

For all changes together, actual `npm pack` archives compared against `55c7d96`:

| Measurement      |      Baseline |     Candidate |
| ---------------- | ------------: | ------------: |
| Package archive  | 178,091 bytes | 178,086 bytes |
| Unpacked package | 459,197 bytes | 459,181 bytes |

The native binary grows by 104 bytes, offset by the smaller JavaScript and other
published changes. Summing individually gzipped files is not the same measurement
as the npm archive; the archive above is the package-size check.

Lua allocation totals matched for flat arrays, nested tables, object tables, and
function calls. Each Wasm heap remained 17,891,328 bytes. Three separate-process
retained-memory runs with 20 live runtimes/states measured about 10.83 MB of JS
heap for the baseline and 9.96 MB for the candidate after forced GC. This is
evidence for the measured workloads, not a guarantee for every application.

Validation on the final native build: 391 default-engine tests passed; 387
fallback-engine tests passed with 4 JSPI-only tests skipped; the upstream Lua
suite finished with `final OK !!!`. A deterministic comparison of 2,000 mixed
table shapes matched the baseline and left both stacks empty. Regression coverage
now also includes numeric string, fractional, zero, and negative keys alongside
array entries. Formatting/lint and `git diff --check` passed.

## Numeric binding setup

Numeric exports now omit their redundant conversion signatures. The constructor
previously allocated 108 signature arrays and checked each entry before returning
the unchanged Wasm export. Missing-export validation remains, as do string
conversion and integer-range checks. The integer binding helper takes its argument
position directly instead of inferring it from another temporary signature array.

```sh
node docs/performance/bindings.mjs /absolute/baseline/dist/index.js /absolute/candidate/dist/index.js
node --expose-gc docs/performance/runtime.mjs /absolute/baseline/dist/index.js /absolute/candidate/dist/index.js
```

The isolated baseline includes the earlier table and call optimizations. The first
constructor comparison measured 22.188 ms versus 19.815 ms for 1,000 wrappers,
10.7% less time; an isolated repeat measured 23.043 ms versus 20.057 ms, 13.0%
less time. The harness releases each wrapper's scratch allocations and uses
the yielding engine to avoid installing an await hook per wrapper. Full runtime
load, state creation, script execution, and close measured 24.625 ms versus
24.297 ms per ten runs, only 1.3% less time; Wasm instantiation dominates that
larger operation. These are warm-process measurements, not cold-start claims.

The combined package now measures 177,862 bytes compressed and 455,691 bytes
unpacked, compared with 178,091 and 459,197 at the original baseline. The binding
change alone removes 3,490 unpacked bytes. Lua allocation totals and Wasm heap
capacity remain equal. A retained-memory comparison with twenty live runtimes
measured 10.57 MB of JS heap before this change and 9.72 MB after; this diagnostic
is sensitive to compilation and GC and is not a universal memory-saving claim.

All 391 tests, formatting/lint, and `git diff --check` pass after the binding
change. A broader interop sweep reproduced the table-push and Lua-call gains;
number and short-string round trips and `doStringSync` were effectively unchanged.
Callback and proxy timings varied with process order. Paired callback measurements
against the original baseline were 1.5–2.6% slower, despite a separate-process
repeat being effectively unchanged. Against the build immediately before the
binding simplification, callbacks were 1.1% slower and proxy access 0.2% slower.
The paired harness is `docs/performance/callbacks.mjs` and
takes the same two index.js paths as the constructor benchmark.

A subsequent control compared two byte-identical copies of the pre-callback
experiment build. The second copy measured 2.3% slower for callbacks and 0.9%
slower for proxy access. Thus the small callback difference above does not
establish a code regression; it is comparable to the harness's control variation.
Removing redundant optional chaining did not improve timings and was reverted.

## Lazy extension identity caches

Extensions now create their weak Lua identity cache on first access. Table copies
never use it, and other extensions do not need it until a value of their type is
pushed. The protected cache reference remains available through a getter, so
custom extensions reading it still receive an initialized registry reference.

```sh
node docs/performance/create-state.mjs /absolute/baseline/dist/index.js /absolute/candidate/dist/index.js
node docs/performance/cache-memory.mjs /absolute/baseline/dist/index.js /absolute/candidate/dist/index.js
```

Against the preceding build, two runs measured these reductions in time for
200 state creations and closes:

| Options          | Time reduction | Lua bytes saved per fresh state |
| ---------------- | -------------: | ------------------------------: |
| Defaults         |       5.8–9.3% |                             392 |
| Object copying   |       5.4–6.1% |                             392 |
| Injected helpers |       2.4–4.8% |                             392 |

After first pushes of proxies, opaque userdata, promises, and errors, the candidate
still used 152 fewer Lua bytes. Repeated pushes retained Lua identity, and both
stacks were empty. After collection it also retained 152 fewer Lua bytes. Wasm
heap capacity stayed at 17,891,328 bytes. Repeated twenty-runtime JS retained-heap
measurements overlapped at roughly 9.71–9.74 MB; they do not demonstrate a JS heap
reduction. A callback/proxy comparison remained within the identical-build
control variation described above.

The combined npm archive is now 177,960 bytes, with 455,889 bytes unpacked, both
below the original 178,091/459,197-byte baseline. Lazy initialization itself adds
98 compressed bytes and 198 unpacked bytes compared with the preceding build.
The default-engine suite passes all 391 tests after this change; the fallback
suite passes 387 with 4 JSPI-only tests skipped. Formatting/lint and diff checks pass.

## Rejected numeric and compiler experiments

Calling the existing native integer helper directly after `pushValue` validates a
safe integer did not improve the global or callback workloads and made the
isolated push loop roughly 10% slower. The duplicate-check bypass was reverted.
Inserting extensions in priority order instead of re-sorting the small list also
produced no convincing setup improvement and was reverted.

The VM harness now covers arithmetic, table allocation/traversal, Lua calls,
string formatting/concatenation, and the existing heapsort fixture. It seeds Lua's
random generator equally for reproducible heapsort inputs:

```sh
node docs/performance/vm.mjs /absolute/baseline/dist/index.js /absolute/candidate/dist/index.js
```

Compiler experiments retained `-Oz` and the existing Binaryen passes:

| Change                       |     Wasm size | Outcome                                                         |
| ---------------------------- | ------------: | --------------------------------------------------------------- |
| Existing no-inline build     | 193,278 bytes | Baseline before the JSPI fix                                    |
| Add LTO, retain no-inline    | 193,565 bytes | No overall VM gain; rejected                                    |
| Remove no-inline             | 194,056 bytes | Faster arithmetic/calls/heapsort, but async correctness failure |
| Remove no-inline and add LTO | 198,945 bytes | Exceeds the size budget; rejected                               |

Default inlining initially looked useful: about 11% faster arithmetic, 6% faster
Lua calls and heapsort, and 1% faster table work, with string formatting about 4%
slower. Its full package still fit below the original size limit. However, the
full suite failed `can interleave many runs with different suspension depths and
settlement orders` with a WebAssembly exception. Running that test alone
reproduced the failure; restoring the previous no-inline artifacts made it pass.
That initial faster but incorrect build was discarded. The investigation and fix
below subsequently made inlining usable; the compiler change had exposed a race
in the library's JSPI stack restoration.

Reproduction against either build:

```sh
node_modules/.bin/mocha --exit --require ./test/boot.js test/async.test.js --grep 'different suspension depths'
```

## Synchronous JSPI restoration

The async await hook used to restore a run's linear-memory C stack before resolving
its promise. There is a microtask gap between that resolution and Wasm resumption,
during which another ready run can restore its own frames over the first run's.
Disabling inlining hid the failure in the existing concurrent-depth test, but a
close-during-settlement stress check also made the old no-inline build trap.

The await hook now returns an integer identifying a ready continuation. A second,
synchronous C hook consumes that continuation and restores the stack immediately
before Lua executes again. A local map holds only ready continuations; entries
are deleted before invocation, including when invocation throws. The synchronous
hook also checks that the state is still open, covering closure during the
promise-resolution gap. Per-await marshalling now uses one outcome callback
instead of four callbacks to offset the new bookkeeping.

The final compiler configuration uses default `-Oz` inlining, without LTO. The
previously failing concurrent-depth test passes, along with the new close-timing
regression, all 392 default-engine tests, 388 fallback tests (4 JSPI-only skips),
and the upstream Lua suite. Formatting/lint and diff checks pass.

Against the immediately preceding no-inline build, the VM harness measured:

| Workload                        | Change in median time |
| ------------------------------- | --------------------: |
| Arithmetic                      |           10.6% lower |
| Table allocation/traversal      |            1.5% lower |
| Lua calls                       |            5.6% lower |
| Heapsort                        |            5.8% lower |
| String formatting/concatenation |           4.2% higher |

The correctness fix costs time on settled JSPI awaits: two runs of
`bench/async.js` measured 32.8–35.0 ms per 20,000 awaits versus 29.6–30.3 ms before
the fix. This regression is explicit; an unsynchronized restore is not an
acceptable optimization. Further reduction of continuation overhead remains open.

For 1,000 parked JSPI runs, measured JS heap growth fell from 4,682,456 to
4,520,328 bytes. Saved-stack ArrayBuffer measurements varied between runs (roughly
28–35 KB before and 30–62 KB after), while Lua allocation growth stayed at
1,177,950 bytes. Total sampled memory was lower. The ready-await diagnostic
samples successive microtask boundaries; its largest observed heap-plus-buffer
delta fell from 5,367,528 to 5,204,872 bytes. Individual phases are not equivalent
work-completion points, so they must not be compared as if they were.

```sh
node --expose-gc bench/async.js /absolute/candidate/dist/index.js
node --expose-gc docs/performance/ready-await-memory.mjs /absolute/candidate/dist/index.js
```

Adding `--close-before-resume` to the latter command exercises the closure stress
case that trapped in the previous no-inline build. The fixed build completes it.

The combined package measures 178,043 bytes compressed and 456,582 unpacked,
still below the original 178,091/459,197-byte baseline. These are measured workload
results, not a claim that every program is faster or uses less memory.

## Direct awaits and compact outcomes

The no-limit JSPI path now awaits the user's promise directly and records its
result in a try/catch. This avoids the extra promise and reactions previously
created by `settleOrInterrupt`. Limited runs still use that helper. Both paths
observe settlement before waiting for the already-scheduled fairness pause, so
rejections cannot go unhandled during the pause. Stack restoration and the final
close/deadline check remain in the synchronous resume hook.

Outcomes now have one `status` discriminator (`fulfilled`, `rejected`, or
`interrupted`) instead of two boolean flags. This reduces outcome size and lets
host-yield error handling combine its two equivalent throw branches.

```sh
node docs/performance/settled-awaits.mjs /absolute/baseline/dist/index.js /absolute/candidate/dist/index.js
```

Compared with the preceding synchronized implementation, two isolated alternating
comparisons measured 29.363/28.635 ms and 29.578/28.835 ms for 20,000 settled awaits,
about 2.5% less time. This recovers part of the synchronization overhead; it is
not a claim that all of that overhead has been removed.

The 1,000-parked-run benchmark's JS heap delta fell from 4,520,328 to 4,304,520
bytes, with unchanged Lua allocation growth of 1,177,950 bytes. The ready-await
diagnostic's largest sampled heap-plus-buffer delta fell from 5,204,896 to
5,041,160 bytes. As above, ArrayBuffer measurements and individual microtask
phases vary; these figures describe the sampled workloads.

The combined package is 178,052 bytes compressed and 456,727 unpacked, below the
original 178,091/459,197-byte baseline. All 392 default-engine tests and 388
fallback tests pass (4 JSPI-only skips), including the close-timing regression.
The close-before-resume stress diagnostic and formatting/lint/diff checks pass.

## One limits snapshot per async entry

An async entry previously called the state's public `getLimits()` (which copies
the configuration), then the child's `setLimits()` (which copies it again).
`LuaState` now forwards the protected configuration directly to `setLimits`,
retaining the child's independent snapshot and the public getter's copy semantics
while eliminating one temporary object per entry.

```sh
node docs/performance/async-entries.mjs /absolute/baseline/dist/index.js /absolute/candidate/dist/index.js
```

Two alternating comparisons of 1,000 short async entries measured:

| Engine | First baseline/candidate median | Repeat baseline/candidate median |
| ------ | ------------------------------: | -------------------------------: |
| Yield  |                2.312 / 2.150 ms |                 2.334 / 2.214 ms |
| JSPI   |                4.767 / 4.412 ms |                 4.913 / 4.569 ms |

That is 5–7% less time for this workload. Retained-memory samples were essentially
unchanged, as expected for removing a temporary copy rather than a retained
structure. The new deadline-isolation regression verifies that changing the
state's deadline leaves a parked run's snapshot intact and affects subsequent
runs. All 393 default-engine tests and 389 fallback tests pass (4 JSPI-only skips),
as do formatting/lint/diff checks.

The combined archive remains 178,052 bytes. Its unpacked contents are 456,741
bytes, 14 bytes above the preceding build because the protected field retains its
type in the declaration file. Both remain below the original
178,091/459,197-byte package baseline.

## Shared return marshalling

Promise resolution and callback returns now share `Thread.pushReturnValues`.
Its optional `nilOnUndefined` flag preserves the one intentional difference:
an awaited undefined produces one Lua nil, while a normal callback returning
undefined produces no values. The duplicate RawResult/MultiReturn dispatch and
element loop were removed from the promise extension. No cache or per-call
container was added.

```sh
node docs/performance/multiple-returns.mjs /absolute/baseline/dist/index.js /absolute/candidate/dist/index.js
```

The harness reuses a three-element MultiReturn to isolate marshalling from array
construction. Two comparisons of 20,000 multi-value JSPI awaits measured
32.344/31.167 ms and 33.808/32.708 ms, a 3.3–3.6% reduction. Callback and fallback
await differences stayed below 1%; scalar settled JSPI awaits varied by about
1.3%, so no gain is claimed for those paths.

The ready-await diagnostic reported identical largest JS heap and ArrayBuffer
deltas before and after (4,815,616 and 224,000 bytes). The combined archive is
178,067 bytes and its unpacked contents are 456,701 bytes, below the original
178,091/459,197 baseline. Relative to the preceding build, unpacked size drops
40 bytes while archive size rises 15 bytes due to compression and declarations.

The nil-versus-empty-return distinction now has explicit regression coverage.
All 394 default-engine tests and 390 fallback tests pass (4 JSPI-only skips),
along with formatting/lint/diff checks.

## Reference registration failure handling

`LuaModule.ref` used to consume a free slot and retain the value in its strong
map before WeakMap registration could reject an unsupported key. Failed calls
could therefore retain rejected values and lose reusable slots. The regression
check reproduced a jump from reusable slot 1 to slot 7 after six rejected values.

Registration now lets WeakMap validate the key first, then consumes and assigns
the reference index and commits the strong entry. The metadata record is the
same allocation as before. Every committed strong entry consequently has
metadata, allowing the old orphan-entry cleanup branch in `unref` to be removed.
Tests verify failed calls leave existing references and reusable slots intact,
and that repeated references release a slot only after the final unref.

```sh
node docs/performance/references.mjs /absolute/baseline/dist/index.js /absolute/candidate/dist/index.js
```

The final 100,000-registration/release comparisons measured 19.331/19.374 ms
with immediate slot reuse and 21.199/21.284 ms with batch release, both within
0.5% of baseline. No speed gain is claimed; the result is unchanged measured
throughput with corrected failure handling and less cleanup code. An initial
peek-before-commit variant was discarded because it slowed immediate reuse.

All 396 default-engine tests and 392 fallback tests pass (4 JSPI-only skips),
as do formatting/lint/diff checks. The combined package measures 178,061 bytes
compressed and 456,636 unpacked, below the original 178,091/459,197 baseline.

## Short-string decoder experiments

The current decoder gathers short ASCII bytes in a temporary array and calls
`String.fromCharCode.apply`. Two alternatives were rejected: scanning ASCII and
passing a typed-array view to `apply`, and scanning before allocating the array.
The first reduced the temporary array's element storage but made 1–32-byte ASCII
decodes 1.9–3.3 times slower. The second added a second traversal and slowed the
same cases by about 3–15%. Neither offered a consistent Unicode improvement.

```sh
node docs/performance/string-decode.mjs
node docs/performance/string-decode.mjs --cutoff
```

This isolated JavaScript probe alternates variant order, discards five warmup
rounds, and measures twenty rounds of 200,000 decodes. It checks decoded values,
including embedded NUL, malformed UTF-8, and multibyte characters. Default output
orders variants as current array gathering, typed-array view, and scan-first
array gathering; cutoff mode replaces the third variant with direct TextDecoder.
It does not establish whole-library or browser performance.

The cutoff probe measured array gathering/direct TextDecoder at 24.454/31.565 ms
for 32 bytes, 29.233/31.812 ms for 40 bytes, and 37.289/32.035 ms for 48 bytes.
The existing 32-byte limit is retained: extending it would only help a narrow
ASCII range while allocating larger temporary arrays, including for Unicode
inputs that ultimately use TextDecoder. No production change or speedup is
claimed from these experiments; memory usage and package size are unchanged.

The broader performance goal remains open. These measurements cover startup,
table conversion, and interop, not every workload supported by the library.

## Cached decoding of short strings

Profiling the proxy and table-read workloads showed no dominant JavaScript hotspot: a
bare JS-to-wasm call costs about 4 ns, so the marshalling is spread thinly across the
extension dispatch, argument arrays, and string decoding, which took 7–9% of samples.
The names read out of Lua repeat: table keys, globals, metamethod keys. `readString`
now keeps the string it built for a run of up to 32 ASCII bytes in a 256-slot
direct-mapped cache keyed by a 32-bit hash of the bytes, and returns it when the same
bytes come round again. The bytes are compared only when the stored hash matches, so a
miss costs the hashing pass; a string is stored only on its second sighting, so a stream
of values read once (the elements of a table being copied) is never stored and cannot
push out the names read between them. Hits also hand `self[key]` lookups the same,
already internalized string. Non-ASCII and longer strings take the TextDecoder path as before.

```sh
node docs/performance/string-cache-variants.mjs
node docs/performance/string-cache.mjs /absolute/baseline/dist/index.js /absolute/candidate/dist/index.js
node --expose-gc docs/performance/string-cache-memory.mjs /absolute/candidate/dist/index.js
```

The isolated probe compares the decoder alone. Verifying bytes on every equal-length
slot, or storing on every miss, made streams of distinct strings 25–90% slower in
isolation; the hash guard and second-touch rule cut that to the hashing pass, about
6 ns per string, while keeping the repeated-name gains. Paired runs of the final
build against the `55c7d96`-based baseline:

| Workload                                                   | Baseline / candidate median | Change    |
| ---------------------------------------------------------- | --------------------------: | --------- |
| 100,000 `data.nested.value` proxy reads from Lua           |            91.1 / 78.0 ms | 14% less  |
| 100 reads of 2,000 `{id, name, active}` tables             |          147.1 / 118.4 ms | 20% less  |
| 100 reads of 2,000 integers under distinct string keys      |            51.0 / 54.9 ms | 8% more   |
| 20,000 global round trips, 8 and 24 character strings       | 5.24 / 5.00 and 9.01 / 8.60 ms | 5% less   |
| 50 reads of 2,000 distinct string keys and values           |            36.3 / 38.3 ms | 6% more   |

Flat array reads, table pushes, Lua calls from JS, callbacks into JS, and the VM
workloads were unchanged within 1–3%. The regression is confined to short ASCII
strings that are each read once; it is the hashing pass, and is accepted for the gains
on the repeated names that make up most reads.

Memory: the cache is per runtime, not per state. Twenty runtimes retained 9.70 MB of
JS heap before and 9.75 MB after, about 2.3 KB each for the two 256-entry hash arrays
and the slot array. Filling every slot with a 32-byte string retained 16 KB more than
the baseline in the worst case probe. Nothing is retained per state, and repeated
reads allocate fewer strings. The Wasm heap is unchanged at 17,891,328 bytes.

## Package size and build targets

The bundle now mangles module level names as well, keeping class names (`keepNames`)
so `LuaState.name` and console output are unchanged; helpers between the classes are
renamed, as they already are inside every method. The browser suite's inlined-page test
referred to the runtime by its bundle-internal name, so it now resolves it through the
export clause. The glue is built for the engines package.json declares (Node 24 and
the browserslist minimums), which drops a `node:crypto` fallback from both glues; the
Wasm is byte-identical.

| Measurement      | Original baseline | Before this change | Now           |
| ---------------- | ----------------: | -----------------: | ------------: |
| Package archive  |     178,091 bytes |      178,061 bytes | 177,822 bytes |
| Unpacked package |     459,197 bytes |      456,636 bytes | 455,025 bytes |

## Rejected: native helpers for stack traffic

Four C helpers were tried and reverted: the metatable address in one call, `lua_next`
returning both entry types, and a get/set pair for the pushed-value identity cache.
They removed two to three wasm calls per proxy read, table entry, or cached push. The
paired harnesses measured 0.4–1.7% on an idle machine (a first run under a concurrent
test suite showed a 20% swing in both directions, which did not reproduce), for 175
more archive bytes from the export names in the Wasm and both glues. With a call
costing about 4 ns, a helper pays off only when it replaces a loop of calls, as
`wasmoon_isarray` does.

Validation of the final build: 396 default-engine tests and 392 fallback-engine tests
pass (4 JSPI-only skips), the upstream Lua suite finishes with `final OK !!!`, and
formatting/lint and `git diff --check` pass. The Wasm binary is byte-identical to the
preceding build, so the VM measurements above are a control rather than a claim.

## Derived bindings and a built CLI

`LuaModule` used to name each of its 145 bindings in the constructor, one `cwrap` call per
export, which was 8.3 KB of the minified bundle. The bindings that cross only numbers are the wasm
exports themselves, so the constructor now fills every declared binding field still empty with the
export of its name, and only the 37 bindings that marshal a string are listed, in one string of
`name:signature` entries that the wrapper reads directly. The field declarations stay, since they
are what keeps the module out of V8 dictionary mode (`%HasFastProperties` still holds), and a
declared binding with no export still fails at construction rather than at first call. The four
helpers that never were exports (`lua_gc`, `lua_resetthread`, `lua_setcstacklimit`,
`luaL_openlibs`) are methods now, like `lua_pop` and `lua_remove`, so the fill pass has no
exceptions to know about and each module carries four fewer own fields and closures.

The CLI is built by rolldown as a second entry, `dist/cli.js`, and `bin` points there. It imports
the library by the package's own name at run time rather than bundling a copy, and the source
moved to `src/cli.js`. Minified it is 4,687 bytes where `bin/wasmoon` shipped 15,547 bytes of
source.

```sh
node docs/performance/bindings.mjs /absolute/baseline/dist/index.js /absolute/candidate/dist/index.js
node --expose-gc docs/performance/runtime.mjs /absolute/baseline/dist/index.js /absolute/candidate/dist/index.js
node --expose-gc docs/performance/retained-memory.mjs /absolute/candidate/dist/index.js
```

| Measurement                | Before this change | Now           |
| -------------------------- | -----------------: | ------------: |
| `dist/index.js`            |      109,564 bytes | 102,407 bytes |
| CLI                        |       15,547 bytes |   4,687 bytes |
| Package archive            |      177,822 bytes | 174,001 bytes |
| Unpacked package           |      455,025 bytes | 437,691 bytes |

Filling the fields by name costs the constructor: three paired runs measured 22.1/35.0, 21.3/33.6
and 21.5/33.6 ms for 1,000 constructions, about 12 µs more each. The stores are keyed rather than
named, the fill pass reads each field once, and the signature string is split; a first version
that walked the module's exports (a dictionary of 177 entries) or tested a regex per field was
slower still, and was replaced. The construction happens once per `LuaRuntime.load`, which
instantiating the wasm dominates: two paired runs of ten load, create, run and close cycles
measured 23.31/23.17 and 23.23/23.46 ms, unchanged within the harness's variation. Twenty live
runtimes retained 9,688,440 bytes of JS heap against 9,751,312 before, and the Wasm heap stayed at
17,891,328 bytes. The wasm binary is unchanged.

All 396 tests pass, including the CLI suite against the built entry, as do formatting/lint and
`git diff --check`.

## A small initial heap and lighter reference bookkeeping

Every heap snapshot so far reported the Wasm heap at 17,891,328 bytes, of which a fresh state used
about 20 KB: Emscripten's default `INITIAL_HEAP` is 16 MB, on top of the 1 MB stack and the static
data. The build now passes `-s INITIAL_HEAP=1MB` and relies on the `ALLOW_MEMORY_GROWTH` it already
had. A fresh runtime's memory is 2,162,688 bytes and the binary is one byte smaller. In Node the
untouched pages never cost RSS either way (a 17.9 MB memory that is never written adds nothing,
touching all of it adds 24 MB), so what this cuts is the address space reserved per runtime, what
`HEAPU8.length`, heap snapshots and browser memory panels count, and the footprint on platforms that
commit the initial memory. Twenty runtimes reserve 43 MB instead of 358 MB.

Growing is cheap: from 2 MB to 18 MB in Emscripten's 20% steps is twelve `memory.grow` calls, which
measure 0.038 ms in total, and the module never caches a heap view across a call that can grow
(`heap` is a getter). A 200,000-table workload that holds 17.9 MB of Lua data ends at a 29,097,984
byte heap against 30,998,528 before, since growth now follows the allocations rather than starting
from 16 MB.

The JS side of a reference has changed too. `LuaModule.ref` used to allocate a metadata record per
JS value Lua holds and keep it in a `WeakMap`, alongside a `Map` from index to value and a list of
free indices. Values and counts are now two dense arrays indexed by the reference index, with the
free slots threaded through the counts array as negated links (a released slot's count is zero or
less), and the `WeakMap` maps a value to its index alone. The slot is taken only after the `WeakMap`
has accepted the value, so a primitive is still rejected without consuming one. `printRefs` walks
the arrays. Threads also start from one shared, frozen empty limits object instead of allocating
`{}` each, which a JS callback made from a Lua coroutine used to do on every call; `setDeadline` is
the one in-place writer and takes an object of its own first.

```sh
node docs/performance/vm.mjs /absolute/baseline/dist/index.js /absolute/candidate/dist/index.js
node docs/performance/callbacks.mjs /absolute/baseline/dist/index.js /absolute/candidate/dist/index.js
node docs/performance/references.mjs /absolute/baseline/dist/index.js /absolute/candidate/dist/index.js
node docs/performance/create-state.mjs /absolute/baseline/dist/index.js /absolute/candidate/dist/index.js
node docs/performance/call-lua.mjs /absolute/baseline/dist/index.js /absolute/candidate/dist/index.js
node --expose-gc docs/performance/retained-memory.mjs /absolute/candidate/dist/index.js
```

Memory, against the preceding build:

| Measurement                                          |         Before |          Now |
| ---------------------------------------------------- | -------------: | -----------: |
| Wasm heap of a fresh runtime                         |     17,891,328 |    2,162,688 |
| Heap snapshot self size per runtime plus state       |     18,286,275 |    2,554,344 |
| JS heap per live reference (100,000 proxied objects) |          120 B |         62 B |
| JS heap retained after releasing those 100,000       |      1,258,496 |    1,987,336 |
| Lua bytes of a fresh state (default options)         |         19,052 |       19,052 |

The one number that grows is the last memory row: the arrays keep the capacity of the most
references ever live at once, where the maps shrank as entries left. That is 16 bytes per slot of
high-water mark, against half the cost while the references are live, and the third list this
design would have needed was folded into the counts array to keep it there. The 390 KB of JS objects
a runtime retains is otherwise unchanged; the largest single piece of it is Emscripten's 4,096-slot
filesystem name table (32 KB), which is generated code and was left alone.

Time, medians of the paired harnesses on an idle machine. The Wasm change alone was measured before
the JS change was built: arithmetic 0.9% less, table 0.1% more, calls 0.3% less, strings 1.4% less,
heapsort 0.3% more, callbacks 0.2% less, proxy reads 0.2% more, all inside the control variation
recorded above. With both changes: 100,000 ref/unref pairs 19.28 / 9.70 ms with immediate reuse and
22.45 / 14.20 ms in batches (50% and 37% less); callbacks 17.18 / 16.67 ms and proxy reads
75.63 / 72.82 ms (3% and 4% less); state creation 7.2%, 3.6% and 0.4% less for the default, copying
and injected configurations; Lua calls from JS 1% to 3.5% less.

One paired result was misleading and is recorded so it is not chased again: `async-entries.mjs`
showed the Wasm change alone 8.5% slower under both engines, but that harness loads two runtimes
into one process, and two *different* wasm binaries no longer share V8's compiled module the way two
copies of one binary do. The heap does not grow at all during that workload (2,162,688 bytes before
and after), and one build per process, alternated three times, spreads over ±15% with no direction
(yield 2.26–2.84 vs 2.25–2.48 ms, JSPI 4.86–5.13 vs 4.58–5.39 ms). The JS change alone in the same
paired harness measured 1.4% (yield) and 7.5% (JSPI) less time.

The package is 174,011 bytes compressed and 437,914 unpacked, against 174,001 and 437,691: the
private fields carry line comments rather than doc comments, since tsc copies the latter into the
published declarations. All 396 default-engine tests pass, 392 fallback tests with 4 JSPI-only skips,
the upstream Lua suite finishes with `final OK !!!` (its peak memory growing the heap to 64 MB along
the way), and formatting/lint and `git diff --check` pass.

Considered and not done: `dlmalloc` in place of `emmalloc` costs about 20 KB of wasm and has the same
8-byte rounding on the small blocks Lua allocates, so it would not shrink the heap; a smaller
`MEMORY_GROWTH_GEOMETRIC_STEP` only trims slack that is never touched; a smaller stack than 1 MB
trades untouched pages for silent corruption on deep C recursion; and moving the per-state function
and continuation trampolines to the module would save two `WebAssembly.Instance` objects per state
at the cost of finding the state from the `lua_State` on every callback.

## Run loop and lifecycle simplification

2026-09-07, Node 26.7.0, against the preceding build (same wasm). A structural pass over `Thread`
with no change in what runs per call: `run` and `continueYielding` share `startRun`, `watchRun`
and `finishRun`; the JSPI result slot is allocated inside `runJspi`; `runSync` and `call` go
through one `pcall` that saves and restores the active run inline, replacing the closure taking
`withSuspensionDisabled`; `resumeYielding`, an alias of `resume`, is gone; the deadline and abort
checks are `limitReached` and `assertLimits`, and the hook unwinds through `interruptWith`. Close
listeners live on the root thread, so `watchRun` no longer casts to reach `LuaState.onClose`. The
function extension releases its call thread on the two exits instead of tracking `handedOff` and
`failed` flags. The `promising`/`suspending` wrappers on `LuaModule` are replaced by typed
`WebAssembly.promising`/`Suspending` declarations, and `PendingSuspend` is a named type in
`async.ts`.

The resume hook keeps its reference map: two parked runs whose promises settle in the same tick
have both hook continuations run before either wasm stack resumes, so a single slot would hand the
first run the second run's restore.

`dist/index.js` 102,579 → 101,894 bytes. One build per process, alternated, medians of 15 rounds
(new vs before): JSPI settled awaits 27.4–28.2 vs 27.8–28.9 ms, Lua→JS calls 3.55–3.67 vs
3.50–3.66 ms, JS→Lua calls 2.97–3.28 vs 3.01–3.05 ms, async entries 5.18–6.06 vs 5.18–6.01 ms;
yield settled awaits 64.3–64.6 vs 63.8–70.3 ms. Every interop row moved less than 3%, inside its
run-to-run variation. 396 tests pass on the default and JSPI engines, 392 with 4 JSPI-only skips
on the fallback, and the upstream Lua suite finishes with `final OK !!!`.

## Reference capacity reclamation and direct binding setup

The reference arrays now discard released tails when at least half their slots can be dropped.
A highest-live-index counter makes the tail walk incremental; rebuilding the free list only
after halving capacity amortizes that work. Tables of at most 256 slots retain their capacity
for reuse. Live indices never move, including indices held by other states. This addresses the
post-release memory regression recorded above without returning to a map and metadata record
per reference. A live reference near the high end still prevents reclamation of earlier holes;
this does not establish a universal bound in terms of the number of live references.

```sh
node --expose-gc docs/performance/reference-memory.mjs /absolute/baseline/dist/index.js
node --expose-gc docs/performance/reference-memory.mjs /absolute/candidate/dist/index.js
node docs/performance/references.mjs /absolute/baseline/dist/index.js /absolute/candidate/dist/index.js
```

The memory probe warms registration first, keeps one low-index reference alive, then registers
and releases 100,000 objects. In the final comparison, JS heap growth while live was
11,690,296 / 11,690,608 bytes; after release it was 1,897,864 / 1,208 bytes. Repeats of the
candidate's released measurement ranged up to about 4 KB. Wasm heap capacity stayed at
2,162,688 bytes. The older map-based implementation measured 17,469,432 live and 923,032
released bytes with this same probe.

Trimming adds work: paired comparisons against the untrimmed arrays cost roughly 3–9% on
100,000 registration/release loops. Compared with the older map-based implementation, the
candidate still measured about 45% less time with immediate reuse and 34–37% less with batch
release. Callback and proxy comparisons varied in direction between runs; no interop speedup
is claimed from this change.

Binding construction now uses explicit assignments again, keeping the numeric exports direct
and the compact string conversion signatures. This removes enumeration, computed binding
stores, signature splitting and substring allocations from each constructor. Binding fields
are type-only declarations; explicit stores keep V8 fast properties without first initializing
all 146 fields to undefined. Both variants were checked with `%HasFastProperties`.

Against the reflective constructor, final paired runs took 20.5–20.8 ms rather than
33.8–34.5 ms per 1,000 wrappers, about 38–41% less time. Full load/create/run/close comparisons
were unchanged to 2% faster; Wasm instantiation dominates those operations. Twenty-runtime
retained-JS-heap probes measured about 10.48 MB before and 10.51 MB after this binding change,
so the larger generated code has a small retained cost despite eliminating transient arrays.
The overall memory constraint still needs broader auditing, particularly sparse reference
tables and the decoded-string cache; these results do not prove it for all workloads.

The final npm archive is 174,453 bytes and unpacks to 442,767 bytes, below the original
178,091 / 459,197-byte baseline. The native binary is byte-identical to the preceding build.
Validation: 397 default-engine tests, 393 fallback tests with 4 JSPI-only skips, upstream Lua's
`final OK !!!`, formatting/lint and diff checks pass. The regression test covers partial and
descending releases, duplicate holders, live-index preservation and slot reuse. A separate
102,400-registration randomized comparison against a JS Map preserved all live values and
indices. All 146 binding fields match the previous build; missing numeric, string and native
exports still fail during construction.

## Sparse references and a smaller decoder cache

The sparse-reference audit kept one high-index reference alive after releasing 100,000 lower
ones. Tail trimming cannot help that case: the two arrays retained about 1.90 MB, versus
0.92 MB for the original map and free-list implementation. Replacing the value array with a
Map reduced retention but made registration/release 42–69% slower than the two arrays, so
that experiment was discarded.

References now use one array. A live slot contains `{ value, count }`; a released slot contains
the negated next free index. Records disappear on release, leaving one backing slot per hole,
as in the original free list. External indices remain one-based, and the array itself is
zero-based. This also avoids paying for a second array while a high live index prevents trimming.

```sh
node --expose-gc --no-flush-bytecode docs/performance/reference-memory.mjs /absolute/baseline/dist/index.js high
node --expose-gc --no-flush-bytecode docs/performance/reference-memory.mjs /absolute/candidate/dist/index.js high
```

The final comparison against the original baseline measured 17.46 / 14.71 MB of incremental
live JS heap, and 0.920 / 0.922 MB after release. Including the runtime and compiled code,
post-release JS heap was 6,055,616 / 6,038,448 bytes, so total retention was lower despite the
roughly 2 KB difference in the incremental measurement. Keeping a low-index anchor instead
allowed trimming to reduce the candidate's incremental retained heap to about 1 KB. Registration
and release still measured 41% less time with immediate reuse and 35% less with batch release
than the original map implementation. The live-record allocation costs about 10–14% on immediate
reuse compared with the two arrays; the batch comparison was approximately unchanged.

The decoded-string cache is now allocated on the first short ASCII read and has 32 slots,
rather than 256. A saturated 256-slot cache failed the retained-memory constraint even after
the other savings. The smaller cache retains the repeated-name gains in the measured proxy and
nested-table workloads while fitting the full-cache memory check. Applications with larger
working sets of names can have more misses than with the 256-slot experiment.

On a miss, decoding 1–8 ASCII bytes now calls `String.fromCharCode` with fixed arguments, avoiding
the temporary numeric array. Longer ASCII strings keep the existing gathering path; Unicode
still uses TextDecoder. Two isolated comparisons of this change measured 8–9% less time for
distinct short keys and values, 7–8% less for distinct short keys with numeric values, and 4–6%
less for nested records. These comparisons used the same cache capacity on both sides. With the
final 32-slot cache, comparison against the original baseline measured 19% less time reading
flat arrays, 23% less for nested records, and approximately unchanged time for distinct-key
objects. The earlier distinct-key regression is no longer established by these measurements.

### Controlling retained-code variation

An initial twenty-runtime comparison appeared to increase JS heap by about 0.75 MB. Heap
snapshots attributed most of that difference to bytecode and associated metadata, including
Node internals. Repeating the diagnostic changed which build retained that bytecode. The
retained-memory harness now reports V8 code statistics; disabling bytecode flushing during
this diagnostic keeps that variable comparable. This is a measurement flag, not a runtime
requirement or a performance recommendation.

```sh
node --expose-gc --no-flush-bytecode docs/performance/retained-memory.mjs /absolute/baseline/dist/index.js
node --expose-gc --no-flush-bytecode docs/performance/retained-memory.mjs /absolute/candidate/dist/index.js
node --expose-gc --no-flush-bytecode docs/performance/retained-memory.mjs /absolute/baseline/dist/index.js --fill-cache
node --expose-gc --no-flush-bytecode docs/performance/retained-memory.mjs /absolute/candidate/dist/index.js --fill-cache
```

`--fill-cache` uses adjacent duplicates whose byte hashes cover every slot, reports the observed
slot count, then removes the Lua source table and collects it. Separate streaming passes of
distinct strings do not fill a cache that admits only repeated hashes; the earlier 4,096-string
probe did not guarantee full bucket coverage either.

| Twenty live runtimes                 | Original baseline | Final candidate |
| ------------------------------------ | ----------------: | --------------: |
| Numeric workload: JS heap            |        10,843,304 |      10,732,480 |
| Numeric workload: external memory    |         1,871,809 |       1,871,809 |
| Filled-cache workload: JS heap       |        10,926,704 |      10,872,512 |
| Filled-cache workload: external      |         1,871,809 |       1,876,929 |
| Wasm heap capacity per runtime       |        17,891,328 |       2,162,688 |

The external-memory increase is the cache's two typed arrays: 256 bytes per runtime. JS heap
plus external memory is lower in both workloads. The 256-slot build instead measured 11,128,936
bytes of JS heap and 1,912,769 external with the same filled-cache probe. These results cover
the measured Node workloads and do not claim every platform has identical object sizes.

The final package is 174,571 bytes compressed and 443,303 unpacked, versus the original
178,091 / 459,197 bytes. The Wasm binary is unchanged in this pass. All 399 default-engine tests,
395 fallback tests (4 JSPI-only skips), upstream Lua tests, formatting/lint and diff checks pass.
New regressions cover holes below a high live index, symbolic values, invalid indices and
ASCII lengths 0–40 on first and repeated reads, including embedded NULs.

The broader sweep still reproduces the compiler tradeoff: arithmetic, calls and heapsort are
about 5–9% faster, while string formatting is about 4% slower. Callback and proxy access measured
about 6% and 16% less time than the original baseline, and JS-to-Lua calls about 4–5% less.
Further VM profiling and browser performance measurements remain open.
