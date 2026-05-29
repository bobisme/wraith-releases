---
title: Wraith release notes and API twin conformance progress
description: Track Wraith releases, protocol support, conformance fixes, streaming work, and local API twin reliability changes.
---

## v0.9.0 - 2026-05-26

**Feature release. Overlay support ships: a consumer team can layer workflow-specific behavior onto a provider-owned base twin without forking the base. v0 is additive-only — overlays add routes, disjoint variants, fixtures, and fault profiles. Base mutations and Lua-handler shadowing are deferred. The 23 existing root twins are byte-unaffected — overlay code paths are inert without a `[base]` config section.**

### Overlay support

An overlay is a normal Wraith twin with a digest-pinned base reference, packaged as a `.wraith` artifact, policy-checked, and composed into a materialized composite twin before serving. The whole feature is opt-in: a twin without `[base]` in `wraith.toml` runs the v0.8.4 code path verbatim.

```bash
wraith init checkout-billing --base billing-api@sha256:abc --owner checkout
wraith record checkout-billing --tag happy-path
wraith synth checkout-billing                              # delta mode default
wraith compose --base billing-api.wraith \
               --overlay checkout-billing.wraith \
               --output composite
wraith serve composite
wraith rebase-check --overlay checkout-billing.wraith \
                    --new-base billing-api@sha256:def      # check overlay against new base
```

See [Overlays](/overlays/) for the full workflow and configuration reference.

### New commands

- **`wraith compose --base <base.wraith> --overlay <ovl.wraith> [--overlay …] --output <composite>`** — merge a base plus N overlays into a materialized composite twin workspace (or `.wraith` archive) in CLI argument order. Deterministic: same inputs produce byte-identical outputs.
- **`wraith rebase-check --overlay <ovl.wraith> --new-base <base@sha256:…>`** — re-run overlay policy and compose validation against a newer base digest. Emits classifications (compatible / additive-safe / conflict) with confidence and evidence. Used by consumers to decide whether to promote an overlay against a base bump without re-recording.
- **`wraith promote --overlay <ovl.wraith>`** — gated promotion of an overlay artifact; requires policy pass plus evidence sufficiency. Evidence-light overlays may be checked but not promoted.

### New flags

- **`wraith init --base <ref> --owner <team>`** — write a `[base]` and `[overlay] owner = "…"` section into the new twin's `wraith.toml`. Without `--base`, a root twin is created (pre-v0.9.0 behavior).
- **`wraith synth --delta | --full | --base-path <path>`** — `--delta` (default for overlays) synthesizes only the routes that diverge from the base; `--full` synthesizes the entire twin; `--base-path` points at a base artifact for delta comparison. Root twins always use `--full` regardless of flag.
- **`wraith serve --overlay <ovl.wraith> [--keep-composite] [--fixture <overlay-name>]`** — convenience macro that composes the overlay (or chain of overlays) into a temp workspace and serves it. `--keep-composite` retains the materialized workspace under `build/composite/<hash>` for debugging; `--fixture <name>` selects which overlay's fixture set seeds the default namespace.
- **`wraith check --fixture <overlay-name>`** — run conformance against a composite while selecting an overlay's fixture set for default-namespace seeding (mirrors `serve --fixture`).
- **`wraith pack --include-diagnostics`** — include compose-phase diagnostics (disjointness proofs, policy findings, rebase-check evidence) in the packed `.wraith` archive's `reports/` tree. Off by default to keep artifacts lean.

### Safety posture

Overlay policy enforcement uses the existing exit-code discipline:

- **Exit 0** — overlay composes cleanly.
- **Exit 1** — user error (bad config, missing artifact).
- **Exit 3** — policy-disallowed capability requested by overlay (weaker scrub posture, base-route deletion, base-variant mutation, Lua handler shadowing). JSON findings emitted with `{path, capability, reason, severity}`.
- **Exit 4** — runtime error during composition.

### Hardening landed in the same release

- **Path-traversal hardening.** `compose --base/--overlay` rejects archive entries whose paths would escape the staging root (`..`, absolute paths, symlink targets outside the input root).
- **Self-contained composite fixtures.** `compose --output` copies the base + overlay `state/fixtures/` trees into the materialized composite. Packed composites are no longer fixture-light.
- **Deterministic `synth_timestamp` in compose.** Two compose runs with identical inputs now produce byte-identical `twin.wir.json` files. Resolved via `SOURCE_DATE_EPOCH` when set, else a hash-derived stable timestamp from the composition digest.
- **`wraith synth --delta` emits `build/delta-report.json`** with per-route `covered_by_base` / `delta` breakdown and structured `advice` (`overlay-is-redundant`, `many-unreplayable`, `base-route-missing`).
- **Overlay invariant checks in `wraith lint`.** `base-digest-invalid`, `overlay-owner-missing`, `capability-inconsistent`, `passthrough-disallowed`, and `overlay-requires-invalid` now flagged by `wraith lint` (previously only by `wraith doctor`). Closes a split-brain between the two safety surfaces.

### Stats

- Lib tests: 2994 → 3472 (+478 across the release).
- 70+ task bones closed across 8 phase gates plus 3 post-tag follow-ups.
- Workspace clippy clean on Rust 1.95.

## v0.8.4 - 2026-05-21

**Patch. Action / query `POST`s no longer mint phantom Create entities.**

`infer_state_op` mapped any `POST` without a `:param` to `StateOp::Create`, including action / query POSTs like `POST /v1/assets/actions/search`. Each call minted a phantom id and persisted a junk entity into the same state store now holding (per v0.8.3) seeded fixtures. Three concrete failure modes resulted: fixture-name collisions, quota exhaustion against `serve.limits.max_entities_per_type`, and state-snapshot pollution.

The fix combines two signals:

- **Path signal.** Closed action-verb vocabulary as the final non-param segment (`search`, `searches`, `query`, `queries`, `count`, `aggregate`, `summarize`, `lookup`), plus the Stripe-style `/actions/<verb>` trailing-segment shape regardless of the verb's lexical form.
- **Response-shape signal.** A Create-classified route whose response body is `{single_array_field}` or `{result_set_key: […], pagination_metadata_key: …}` with known result-set and pagination keys is declassified to `None`.

Declassified routes serve via the existing no-state-op dispatch branch with zero state mutation. Conservative non-flips (`find`, `events`, `batch`, `bulk`, plural action-nouns) wait for the response-shape signal before declassifying, so real Create endpoints whose last segment happens to lexically match a query-verb-shaped noun stay classified correctly.

Operators of twins whose response shape now triggers the heuristic (e.g. Stripe `POST /v1/customers/search`) should re-run `wraith synth` to pick up the fix.

## v0.8.3 - 2026-05-21

**Patch. `state/fixtures/` is no longer dead at serve time.**

`StateStore::load_fixtures` had existed since v0.1 but had zero production callers — `wraith init` created `state/schema.json` and `state/fixtures/` but `wraith serve` never read them, so the documented fixtures format was inert. Any state-backed Read / List started a session with an empty store regardless of what was on disk.

Wired through end-to-end:

- A new `SynthHandler::with_lua_and_fixtures(model, lua_dir, twin_root)` constructor takes the twin root. The existing `with_lua` is now a thin wrapper passing `None` so in-tree callers keep compiling.
- `serve.rs` passes `Some(twin_root)` so fixtures participate by default.
- `<twin_root>/state/schema.json` (author-declared `entity_types`) merges into the route-derived schema. Route-derived wins on conflict. An empty `entity_types: {}` (the `wraith init` default) is fully inert.
- `<twin_root>/state/fixtures/<entity_type>.json` is loaded once per `X-Wraith-Session` namespace, lazily on the first request that creates that namespace. The default namespace is also seeded on its first request. Re-seeding does not happen on subsequent requests within the same session, so a delete persists.
- Inert by default: a twin with no `state/schema.json`, no `state/fixtures/`, or an empty schema gets pre-v0.8.3 behavior. Missing or malformed files warn-log and proceed rather than crash `serve`.

**Use case.** Multi-twin demos and coordinated test scenarios where several twins share an entity (e.g. customer `cus_123` referenced consistently across a CRM twin, a billing twin, and an orders twin) can now be set up by authoring one fixture per twin under `state/fixtures/` rather than driving a `POST` sequence on every fresh session.

**Known interaction with outbound scrub.** Wraith's scrub pipeline runs on every outbound response, including responses built from seeded fixtures. A fixture entity with a `name` field (or any field the default PII detector classifies) will have that field tokenized on the wire. This is documented behavior from the v0.6.0 PII work, not a regression — but it's a usability cliff for fixture authors. Workarounds: declare the field in `scrub.toml`'s allowlist, or set `[pii] detect = false` for twins where seeded data is not real PII.

## v0.8.2 - 2026-05-19

**Patch. Closes a latent `$arr_N` placeholder leak on List and Read routes.**

v0.7.1 floored the Create path against variable-length-array markers (`["$arr_N"]`), but `handle_list_sync` and `handle_read_sync` build the response from a raw or merged `body_template` and only ever rewrote the **top-level** collection array. A marker nested anywhere else — `{"data":{"items":["$arr_0"]}}` or a sibling `meta` / `facets` array — reached the wire verbatim on List / Read requests.

A shared `expand_variant_arrays` floor (mirrors the v0.7.1 Create-path floor: same deterministic per-request hash, idempotent, no-op when the variant declares no `array_reps`) now runs at every List / Read body-surfacing site. No behavior change for routes without nested array placeholders; the 23 existing twins are unaffected.

## v0.8.1 - 2026-05-18

**Patch. Completes the v0.8.0 CORS preflight fix for the default `strip_headers = true` config.**

v0.8.0 correctly carried `access-control-allow-{methods,headers}` and `vary` into the synthesized `OPTIONS` variant, but with `strip_headers = true` (the `wraith init` default) the serve-time header stripper's allowlist only permitted `allow-origin` / `allow-credentials` / `expose-headers`. A real browser preflight therefore still lost `allow-methods` / `allow-headers` / `vary` and every cross-origin request stayed blocked — i.e. the v0.8.0 fix was inert for the most common configuration.

`access-control-allow-methods`, `access-control-allow-headers`, `access-control-max-age`, and `vary` are now in the default allowlist. Conformance scoring is unaffected (it uses a separate `CONFORMANCE_HEADERS` list). Verified end-to-end against real recordings with `strip_headers = true`: the synthesized preflight matches the recorded upstream byte-for-byte on all four CORS headers.

## v0.8.0 - 2026-05-18

**Feature release. Closes three consumer findings: dropped CORS preflight headers, array element variety, and request → response correlation. Every new behavior is opt-in or a strict bugfix — the 23 existing twins are byte-unaffected unless the operator opts in.**

### CORS preflight headers no longer dropped

`wraith serve --fidelity synth` returned a bare `204` for cross-origin `OPTIONS` preflights, dropping `access-control-allow-{origin,methods,headers}` and `vary` — every cross-origin replay was browser-blocked. Two causes: (1) a no-body status group (OPTIONS / 204 / 304) collected its static headers only from a body-bearing exchange, yielding an empty header map; (2) the empty-body serve short-circuit emitted only the static map and ignored `header_programs` (where the classified CORS headers lived). Body-less variants now carry the recorded headers plus classified programs, and the empty-body path renders programs the same way the non-empty path does (still an empty body for 204 / 304). Strict-mode behavior was already correct; synth now matches it.

### Configurable array-element variety

`array_length = "p90"` (v0.7.2) recovered a ~500-long array but anti-unification retained only `MAX_REPRESENTATIVES = 8` distinct elements, tiled to length — list UIs showed 8 rows repeated ~62×.

- **`[generate.anti_unification] max_array_representatives`** — an integer N (a deterministic, size-bounded sample of up to N distinct elements in first-seen order) or `"all"` (every distinct element). Default `8` → byte-identical to pre-v0.8.0 output.

### Request-keyed response bucketing

A route whose response depends on a *request* field (a parent id, a `useCase` scope, a search filter) collapsed every value to one global representative — expanding any tree node returned the same payload.

- **`[generate.request_keying] mode`** — `"off"` (default, inert) | `"manual"` | `"auto"`.
- **`[[generate.request_keying.route]]`** `{ route, fields }` — explicit per-route request-body JSON-path key(s); multiple fields form a composite key.
- **`auto`** additionally auto-detects a key for unruled routes, accepting a request field only when bucketing by it yields response-coherent, mutually-distinct buckets.

Synthesis emits one request-guarded variant set per bucket; the whole-route synthesis is appended once as the specificity-0 fallback for an unknown key. The runtime needs no change — `select_variant` already scores `FieldEquals` over the request body and prefers the more specific guard.

### Recommended config

```toml
[generate.anti_unification]
array_length = "p90"
drop_empty_array_responses = true
max_array_representatives = "all"   # or a bound, e.g. 200

[generate.request_keying]
mode = "manual"

[[generate.request_keying.route]]
route  = "POST /v1/assets/actions/search"
fields = ["$.bulksearchv1AssetsInput.filter.parentId"]
```

## v0.7.2 - 2026-05-15

**Feature release. Adds configurable array-length policy and an opt-in empty-response filter so synth handles bimodal and search corpora. Both knobs default to pre-v0.7.2 behavior exactly — existing twins are unaffected unless the operator opts in.**

A debounced keystroke-search endpoint records a flood of empty no-match responses interleaved with a few fat catalog loads. Anti-unification rendered such routes with anemic ~1-element arrays even though the recordings carried real catalog data.

- **`[generate.anti_unification] array_length`** — `"median"` (default) | `"p75"` | `"p90"` | `"max"`. Selects which statistic of the observed-length distribution becomes the rendered array length. Nearest-rank percentile method.
- **`[generate.anti_unification] drop_empty_array_responses`** — `false` (default). When `true`, responses whose every array is empty are excluded from anti-unification *per status group, and only when at least one non-empty response exists for that group* (never prunes to zero). Error envelopes and scalar responses are never dropped.
- **Empty-majority gate is now policy-aware.** Anti-unification collapses an array to a constant `[]` when ≥2/3 of observations are empty. That gate is now skipped under any non-`median` policy (the operator explicitly asked for the fat shape).
- **Actionable fidelity warning.** The `array fidelity warning` emitted during `wraith synth` now reports the active policy and, on the collapse-prone defaults, prints the exact `wraith.toml` stanza to apply.

### Recommended config for bimodal / search APIs

```toml
[generate.anti_unification]
array_length = "p90"               # or "max"
drop_empty_array_responses = true
```

## v0.7.1 - 2026-05-14

**Patch release. Fixes a `$arr_N` placeholder leak in the synth-mode Create dispatch — `wraith serve --fidelity synth` was returning literal `["$arr_0"]` markers in responses (and persisting them into state) for routes classified as Create whose anti-unified body templates carried variable-length array placeholders.**

`handle_create_sync` built the response entity from the raw `body_template` (carrying the literal markers), then overlaid that entity onto the renderer's expanded body via `merge_with_template` — the entity's literal marker clobbered the expanded array. The unexpanded entity was then persisted back, so subsequent Read / List on the same id kept re-emitting `["$arr_N"]` instead of recorded data.

Fixed at two layers:

- **Entity construction.** `build_entity_from_template` now expands `$arr_N` markers against `variant.array_reps` before scrubbing and persisting, so state never holds the literal placeholder.
- **Belt-and-suspenders.** `handle_create_sync` re-runs `expand_array_placeholders` on the merged body after `merge_with_template` (both holes and no-holes branches) — idempotent floor mirroring the existing `scrub_hole_placeholders` pass. Any future entity-construction regression that re-introduces a marker can't reach the wire.

The follow-up nested-placeholder leak on List / Read routes is fixed in v0.8.2.

## v0.7.0 - 2026-05-13

**`wraith generate` hardening release. Four review passes on generate alone surfaced 11 fixable bugs — budgets that didn't enforce, audits that didn't write, scores that disagreed with `wraith check`, rejection reasons that hid the real cause. All fixed. The agentic and single-shot loops are now trustworthy enough to drive in CI.**

### Hard budgets

- **`--time-budget` cancels in-flight LLM calls.** Was advisory — a stalled call ran until external SIGKILL. Now each provider call is wrapped against the run-level deadline; on expiry the in-flight HTTP future is dropped and the process exits within `time_budget + 5s` grace. Covers ollama, openai, openrouter, and command providers, in agentic and single-shot modes.
- **`--token-budget` enforced per-call.** The LLM's completion is capped at `min(8192, tokens_remaining)` so a single response can't push wildly over budget. Prompt tokens are also accounted now — `estimate_prompt_tokens()` (chars/4) subtracts from the budget before `max_tokens` is computed, and the call is skipped entirely when the prompt alone would exceed the budget. Stripe-sized prompts (~28k tokens) overshoot dropped from ~22% to ~0%.

### Conformance and audit fidelity

- **Generate's score matches `wraith check`.** Previously generate called the conformance engine with `lua_dir=None`, so on twins with Lua handlers (orderledger has 7) the engine returned 501s the diff engine saw as 233 phantom divergences. The Lua directory is now threaded through every call site; generate's reported score equals `wraith check --in-memory`.
- **`generate-audit-*.json` written on every run.** Previously the audit directory was empty after every run (wrong write path). A new RAII writer atomically rewrites the file at start, after each round, on success, on error, and on panic-unwind. Schema: timestamps, twin/provider/model, budgets, initial + final conformance, per-route patches with reasons, per-round agentic transcripts, token spend, exhaustion reason.
- **SIGKILL-safe audits.** A new `started` exhaustion-reason marker is written at construction so SIGKILL'd runs leave a meaningful marker on disk — readers can distinguish "still running" from "completed cleanly" instead of seeing `null`.

### Envelope honesty

- **Unified `exhaustion_reason` across envelope and audit.** Was two separate enums with different precedence — the same run could report `iterations` in the envelope and `budget_exhausted` in the audit. Now a single enum with documented precedence (`error > panic > killed > time_exhausted > budget_exhausted > iterations_exhausted > completed`); the two surfaces always agree.
- **Token-vs-time precedence is honest.** A pre-call gate previously set a generic `budget_hit` flag that mapped to `time_exhausted` always — so a token-budget run reported `time_exhausted`. A typed `BudgetHitCause` carries the specific cause and routes each variant to the right `ExhaustionReason`.
- **Real rejection reasons.** Rejected patches no longer all report `"no edits made"`. Each rejection site emits a specific `rejection_reason: budget-exhausted | parse-failure | regression-rejected | empty-edits | protocol-failure | llm-error | user-declined`.

### Working `--interactive`

- **`--interactive` now actually prompts.** Was declared and documented but never read. Now: before applying each accepted patch, a unified diff of `{status, headers, template}` is printed to stderr followed by `apply this patch? [y/N]:`. `y` / `yes` accepts; anything else (including EOF / empty line) rejects with `rejection_reason: user-declined`. Stdout JSON envelope stays clean. Works in both agentic and `--no-agentic` modes.

### Stats

- Lib tests: 2890 → 2953 (+63 across the release).
- 11 generate-related bones closed across 4 review passes; zero open bugs at cut.


## v0.6.0 - 2026-05-11

**Brutal-review shakedown. 14 review passes, 70+ fixes, zero open bugs at cut. New wire-mode conformance, new `wraith install`, principled PII machinery.**

### New commands

- **`wraith install <pack.wraith>`** — inverse of `wraith pack`. Extracts a packaged twin into a usable workspace. Verifies per-artifact digests before writing any files. Defense-in-depth PII rescrub on extraction. `--name`, `--into`, `--force`, `--no-verify`, `--rescrub`.
- **`wraith check --wire`** — wire-mode conformance. Spawns the real serve on a loopback port and replays recorded requests through it. Catches protocol-level bugs the in-memory check is blind to (header stripping, scrub layer mismatch, status code drift). Emits a separate `wire_fidelity_bp` score with the same partial-credit formula as the replay score.
- **`wraith check --upstream`** without `--target` or `--in-memory` now defaults to in-memory replay (previously silently no-op'd). Emits info advice noting the implicit choice.
- **`wraith reduce` strategies are distinct.** `coverage` uses greedy set cover; `diversity` uses farthest-point-first by Jaccard distance; `recency` ranks by timestamp. Invalid `--target-size` (e.g. `abc`, bare `50` without `%`) now exits non-zero with a hint instead of silently no-op'ing.

### Conformance honesty

- **Error-severity divergences count against the score.** `wraith check` no longer reports 100% conformance while emitting thousands of severity=error divergences. Any error-severity divergence on an exchange zeros the affected component score.
- **`drift_type` classifier refined.** New `numeric_drift`, `host_rewrite`, `url_drift`, `value_drift`. `enum_expansion` reserved for real string-enum cases.
- **`upstream_fidelity_bp`** — separate score answering "does the twin look like the live upstream right now?" Network failures degrade gracefully.

### State engine fidelity

- **404 on unknown IDs** for Read endpoints when both 2xx and 4xx variants are present. `GET /v1/customers/cus_FAKE` → 404 instead of 200 with empty body.
- **POST /:id classified as Update**, not Create. Matches Stripe convention. Sub-resource POSTs (`/cancel`, `/capture`) still classify as Action.
- **DELETE preserves pre-mutation membership** — first delete returns 200, second returns 404. Was: first delete returned 404 with `deleted:true` body (status/body mismatch).
- **List endpoints honor pagination** — `?limit`, `?offset`, `?page+per_page`, `?starting_after`, `?ending_before`, `?cursor`. `has_more` is set when the template carries the field. Stripe, PostgREST, page-style, and Google-style conventions covered.
- **List handler is O(limit), not O(N).** `?limit=10` against 10k entities: 70ms → 7ms. 1000 parallel `?limit=10`: 66s → 0.7s.
- **`Idempotency-Key` honored on POST** (opt-in via `[serve.idempotency]`). Per-namespace `(route, key) → cached response`.
- **REST and GraphQL malformed bodies return 400.** Empty body, primitives, shape-mismatched arrays all rejected with a structured `invalid_request_error` envelope. Default fallback when no recorded 4xx variant exists.
- **URL normalization at request entry.** `/v1/customers/.` and `/v1/customers/..` are rejected with 400; `/v1/customers//` collapses to the list route. RFC 3986 dot-segment handling.
- **Seen IDs serve recordings verbatim.** When the request path matches a recorded URL exactly, serve the recorded body bit-for-bit. The new hash-based variation only fires for unseen IDs.

### Synthesis fidelity

- **Path collapser preserves collection roots.** `/v1/balance`, `/v1/charges`, `/v1/payment_intents`, etc. stay as specific routes; only ID-shaped segments become `:param`. No more spurious `/v1/:param` catch-alls.
- **Numeric path segments collapse to `:param` after N distinct values** (was N=∞). `/pokemon/{1,4,25}` → `/pokemon/:param`. Was: 3 separate routes; unseen IDs returned 501.
- **Array length distribution preserved.** Synthesized responses render arrays at the median observed length, cycling through up to 8 representative elements, instead of folding to a single placeholder.
- **Cardinality-detected per-twin enum_paths.** A new synth-time analyzer marks low-cardinality high-repetition kebab/snake-case fields as enum. The PII walker skips them. No more hardcoded list of "pokeapi.ability.name" / etc. entries in source — a new API (Discord, Salesforce, anything) gets the same treatment automatically.
- **Per-request hash-seeded representative selection.** Same path → same response (deterministic). Different paths → different response content drawn from observed representatives.

### Runtime fidelity

- **Lua handler errors return 500.** Previously silently fell through to template rendering with a random `muxemwxu`-shaped id, making test failures invisible.
- **Lua handlers resolve by filename convention** when no explicit hook is set in the model. Was: synthesis never populated `vm.lua_hook`, so handlers loaded but never ran; template rendering clobbered computed values (`total: 134.34` template constant).
- **Form-encoded numeric scalars coerce to recorded type.** Stripe `amount=8888` now renders as `Value::Number(8888)` (was `"8888"`).
- **Clock holes resolve per-request.** New `[serve.clock] mode = real | deterministic | fixed`. Default is real wallclock; deterministic uses a seeded monotonic counter.
- **URL rewrite on outbound responses.** Absolute URLs at the recorded upstream host are rewritten to point at the twin. Third-party URLs (GitHub raw, CDNs) preserved verbatim (was being replaced with UUID placeholders).
- **Vendor headers stripped on serve** by default (`Cf-Ray`, `X-Cache`, `Server`, etc.). Configurable via `[serve] strip_headers`.

### Scrub and PII

- **Default scrub rules cover email, phone, name, SSN, git author blobs.** Git commit metadata in GitHub recordings is tokenized at write time.
- **Doctor scans recordings + model bodies for PII.** New `--allow-pii` flag downgrades findings to info. `wraith export openapi github` and `wraith pack` both re-scrub before emit so legacy twins don't ship raw PII.
- **`[pii]` scrub.toml section.** `detect` toggle, `allowlist` for legitimate non-PII paths, `default_action`, `fields.always` for explicit overrides. Suffix-matching on `*_name` / `*_email` catches `customer_name`, `employee_name`, `author_email`.
- **`pseudonymize` scrub action** — deterministic `user_<base62>` replacement keyed by HMAC. Stable across recordings/exports/packs for the same input.
- **`wraith pack` archives are byte-stable** with `[serve.clock] mode = "deterministic"`. Two consecutive packs produce identical sha256 hashes.
- **`wraith verify-pack` reports PII findings** alongside the digest check. `--strict` flips warnings to failures.
- **Confidence-based outbound scrub on live serve.** Enum values (`bulbasaur`, `grass`, `razor-wind`) preserved; real person names (including short ones like `bob`) tokenized. Cardinality detection distinguishes thing-with-a-label-name entities (preserve `.name`) from person-with-a-personal-name entities (scrub).

### gRPC

- **`grpc-status` in HTTP/2 trailers** for non-empty bodies. Was in initial headers — a spec violation that grpcurl, tonic, gRPC-Go, gRPC-Java, and official Python gRPC all reject. Empty-body errors still use the spec-permitted Trailers-Only form.

### Reliability

- **UTF-8-safe `common_prefix`.** Synthesis no longer panics on multi-byte UTF-8 (Japanese, Cyrillic, accented Latin, emoji). API twins for internationalized APIs (anything with localized strings) build successfully.

### Stats

- Lib test count: 2403 → 2890 (+487).
- 14 brutal-review passes; ended with zero open bugs.
- 70+ feature/fix commits since v0.5.2.

## v0.5.2 - 2026-05-01

**Streaming and capture fidelity. Three new fixture twins.**

### Streaming + recording

- **`wraith record` survives SIGTERM mid-stream.** Long SSE/gRPC streams cut by SIGTERM (or `wraith record stop`, vessel, systemd) now persist their WREC and session manifest with `truncated=true` instead of vanishing silently. The forward proxy now also handles SIGTERM; previously only `Ctrl-C` was caught.
- **In-flight streams pin sessions against the idle timeout.** A long SSE stream (e.g. an LLM streaming for >30s on CPU) no longer fragments surrounding exchanges into separate sessions in `wraith inspect`. Sessions close when the activity actually stops, not when the next exchange happens to start.
- **gRPC replay is byte-faithful for fixed-length arrays.** Fixed-position event slots in a recorded stream now render with the correct per-slot template instead of position 0's. No more ghost proto3 default values on the wire.
- **Synthesized 429 bodies match the route's recorded 4xx shape.** Stripe gets `{error: {type, code, message}}`, GitHub gets `{message, documentation_url}`, Twilio and GraphQL likewise. Fallback when no 4xx is recorded is a structured `{status, code, message, retry_after}` - friendlier to clients deserializing into typed error structs.
- **Volatile response headers freshly emitted at serve time.** `Date`, `Server`, `X-Request-Id`, `Cf-Ray`, `Etag` are dropped at synth time and synthesized at serve time so 200s and 429s carry the same wallclock `Date` source - important for HMAC signers and freshness checks.

### Variant routing

- **Header presence as a guard.** When a single route records both authed (200) and unauthed (401) shapes, `wraith synth` infers `HeaderPresent` / `HeaderAbsent` guards on the discriminating header (e.g. `Authorization`). At serve and check time, requests route to the matching variant. Header-name-agnostic - any consistently-present-vs-absent header qualifies.

### `wraith.toml` artifact completeness

`twin.wir.json` is the documented portable twin artifact. It used to silently drop several pieces of metadata that `wraith serve` already supported via the in-memory model. Now round-tripped:

- Per-route binary content type and body (HTML, plain text, opaque binary endpoints)
- Per-route gRPC marker
- Per-variant Lua hook handler
- Per-route symbol table
- Per-variant header programs and optional-field lists

All additions are backward-compatible - existing `twin.wir.json` files load unchanged.

### Other

- Exercise scripts force a session boundary (`POST /__wraith/new-session`) between recording iterations. Multi-session runs now produce real session boundaries instead of one giant session.
- `wraith inspect` surfaces refresh probe recordings (`recordings/refresh/<run_id>/sessions/`) alongside regular ones.

### New twins (podman fixtures)

Three streaming-fixture twins for contributors to replay end to end:

- **mercure** - pure SSE hub. Infinite-stream regression target.
- **caddy-sse** - minimal controlled SSE fixture with configurable event count, cadence, and payload shape.
- **qdrant** - vector DB gRPC twin. Validates the unary gRPC + protobuf-descriptor pipeline.

## v0.5.1 - 2026-04-30

**v0.4 shakedown follow-ups. Twin-quality fixes + lifecycle commands.**

### Twin-quality fixes

- **DELETE replay matches recorded shape.** `wraith serve` now renders the variant body template on DELETE instead of substituting a hardcoded `{deleted, id}` body. Literal fields like `object: "coupon"` survive.
- **Numeric epoch fields stay numeric.** Fields like Stripe's `created` (Unix epoch seconds, integer) are no longer overlaid with ISO 8601 strings. The classified clock unit (`epoch_sec` / `epoch_ms` / `iso_string`) drives output, not the field name.
- **No more `$hole_*` placeholder leaks.** Unfilled holes can never reach the wire under any classification. The hole classifier learns ID shape from observations: prefix, length, and character class. Stripe-shaped IDs (`cus_<14 base62>`) and short token fields (e.g. 7-char uppercase alnum) are generated correctly.
- **`/__wraith/ready` returns 200 once the listener is bound.** Previously it returned 503 forever, breaking `wraith up`'s ready poll and `wraith status`'s ready probe.
- **`wraith coverage` reports real session counts.** Previously every route showed `sessions=0`.
- **Trace ring buffer captures non-200 responses.** `--trace` now records 429s, fault-injected 5xx, throttle, drop, and timeout responses - exactly the responses you want with `--chaos-seed --trace`.

### New commands

- **`wraith down`**: stops twins started by `wraith up`. SIGTERM with SIGKILL escalation. Idempotent.
- **`wraith status`**: per-twin alive + ready report. Polls `/__wraith/ready` for each running twin.
- **`wraith env`**: emits `WRAITH_<NAME>_PORT` and `WRAITH_<NAME>_BASE_URL` for each twin in the project manifest. Pasteable into a shell or consumed via `--format json`.

### Manifest plumbs simulation flags through `wraith up`

Project manifests can now drive the v0.4 simulation layers per twin:

```toml
[twins.stripe]
path = "twins/stripe"
port = 8181
chaos_seed = 42
latency_mode = "auto"
trace = true
trace_capacity = 500
rate_limit = true
rate_limit_override = ["GET /v1/foo=5/1sec"]
debug = false
listen = "0.0.0.0:8181"
fidelity = "synth"
```

All fields optional; existing manifests parse unchanged.

## v0.5.0 - 2026-04-29

**SSE and gRPC server-streaming.** Record, synthesize, serve, and conformance-check streaming APIs end to end. See the [Streaming](/streaming/) guide.

### Streaming protocols

- **SSE** (`text/event-stream`): `wraith record` captures live without buffering - long-lived streams no longer deadlock the recorder. `wraith serve` emits realistic streams with per-event timing and rotating per-event content (an LLM twin emits the recorded token sequence, not one repeated character).
- **gRPC server-streaming**: `wraith record` forwards frames live with HTTP/2 trailers preserved. `wraith serve` emits frame-correct length-prefixed protobuf with `grpc-status` trailers - gRPC clients connect and stream without `Internal: missing trailers`.
- Long-lived bidi streams (cancelled by client deadline, no trailers received) classify as truncated; replay matches.

### Conformance for streaming exchanges

`wraith check` now scores streaming exchanges under dedicated PASS criteria:

- Event count must match the recording.
- Per-event structural shape (keys, types, constants) must match.
- Hole-marked fields (variable LLM token text, etcd event keys) tolerate value variance.
- Termination shape and gRPC trailers must match.

Previously, streaming exchanges rolled up into the unary scorer where streaming-specific divergences could be diluted into a passing score. New behavior: a streaming Error-severity divergence fails the session.

### `[[diff.suppress]]` now affects the score

Suppression rules in `wraith.toml` are applied before scoring, so a suppressed divergence no longer counts against the conformance score. Previously `[[diff.suppress]]` filtered the report only.

### Variant routing

`wraith synth` infers body-field guards on routes whose variants are discriminated by request-body string fields. Glob paths like `messages[*].content` are supported. At serve time, when multiple variants' guards match a request, `wraith serve` picks the most-specific variant - so a request that matches both a loose 200 catch-all and a tight 404 error variant routes to the 404.

A single route can mix streaming and non-streaming variants. The 200 SSE variant serves a stream; the sibling 404 invalid-model JSON variant serves a normal response.

### New twins

- **ollama** - twins the OpenAI-compat `/v1/chat/completions` endpoint with `stream: true` for any local Ollama model.
- **etcd-streaming** - extends the etcd twin with `KV.Watch`, the canonical server-streaming RPC.

Both ship with podman fixtures so contributors can replay end-to-end.

## v0.4.0 - 2026-04-21

**Faulty-service simulation + OpenAPI seed + trace endpoints. Six orphan subsystems wired into the CLI.**

See the [Simulation](/simulation/) guide for the fault/latency/rate-limit story end to end.

### Realistic simulation in `wraith serve`

- **Fault injection** (`--fault-profile <path>`, `--chaos-seed <u64>`): six fault types (Error / Delay / Timeout / Drop / Throttle / Partial), deterministic seeded RNG, route globs, header matching, percentage rolls, per-rule trigger caps. `generate_chaos_profile` builds a realistic mix from the loaded WIR when given just a seed.
- **Latency simulation** (`--latency-mode <fixed|uniform|recorded|normal|percentile>` + aux flags): per-route overrides, seeded ChaCha RNG for deterministic replay. When a fault `Delay` rule fires, it replaces the latency simulator's contribution for that request (no compounding).
- **Rate-limit simulation** (`--rate-limit`, `--rate-limit-override "METHOD /path=N/Wsec"`): FixedWindow and SlidingWindow algorithms, standard `X-RateLimit-*` + `Retry-After` headers, shared 429-response builder for fault `Throttle` and the rate-limit gate.
- **Evaluation order**: rate-limit -> fault -> latency -> dispatch. All three layers are `Option<Arc<...>>` - zero overhead when their flags are absent.

### Trace endpoints (`--trace [--trace-capacity N]`)

- `GET /__wraith/trace/log` returns the ring buffer in reverse-chronological order.
- `GET /__wraith/trace/<id>` fetches a single trace by id.
- `POST /__wraith/trace/reset` clears the buffer.
- Bounded ring buffer with FIFO eviction. Same control-plane auth policy as the existing `/__wraith/*` surface. Disabled by default.

### Drift classification in `wraith check`

- Each divergence gets a stable `drift_id` (fingerprint) and a `DriftType` classification (schema-change / field-removed / status-shift / etc.).
- JSON envelope adds a `drifts[]` summary grouping divergences by `drift_id`, and per-divergence `drift_id` + `drift_type`. Additive only - existing consumers see the old shape when `skip_serializing_if` suppresses empty fields.
- `twins/<name>/drift.toml` (sibling of `scrub.toml`) supports `[[suppress]]` and `[[reclassify]]` rules matched by glob on `drift_id` / `route` / `path` / `drift_type`. Absent file is a silent no-op.
- Refresh integration deferred until refresh's probe-execution path lands.

### OpenAPI seed mode

- New `wraith explore --from-openapi <spec.yaml> [--against <url>]`: parses OpenAPI 3.x (YAML or JSON), generates scenario plans, optionally executes them against a live URL and reports per-step match/mismatch/error counts. Auth via repeated `--header` flags.
- `wraith coverage --openapi <spec>` extends coverage to report spec-vs-recordings gaps (`covered_count`, `total_count`, `uncovered_operations`).
- Additive JSON envelope fields - no breaking changes to existing coverage consumers.

### Post-v0.3.0 bug-hunt round

- **Router backtracking**: literal subtrees with wrong-method no longer block backtracking to param subtrees.
- **Scrub null handling**: null JSON values no longer get tokenized.
- **Header allowlist**: user `with_extra_compare_headers` opt-ins no longer overridden by blanket x-* filter.
- **Sync conformance replay**: query params now carried through.
- **VCR base64 handling**: case-insensitive `base64` detection.
- **Async CRUD handlers**: error-variant short-circuit restored across Update / Delete.
- **Async `handle_list`**: array-key detection + totalItems / totalPages parity with sync path.
- **Async/sync drift eliminated**: async CRUD handlers now delegate to sync `dispatch` (-561 LOC of duplicate logic).
- **Clock holes carry unit info**: `ClockUnit::{EpochSec, EpochMs, IsoString}` with serde-compatible migration.

### Stats

- **1991 lib tests passing** (+43 vs v0.3.0). 40+ new integration tests across `e2e_fault`, `e2e_latency`, `e2e_rate_limit`, `e2e_serve` trace suite, `explore_openapi`.
- `cli/up.rs`, `cli/refresh.rs`, synth-side rate-limit / latency auto-population remain TODO for v0.4.x or v0.5.

---

## v0.3.0 - 2026-03-30

**18 twins (REST + GraphQL + gRPC). All PASS. Honest conformance with granular suppression.**

### gRPC support (full pipeline)

- **Protobuf codec**: decode (wire->JSON) and encode (JSON->wire) via prost-reflect. 14 tests.
- **gRPC framing**: detect, parse, encode length-prefixed frames, extract trailers. 21 tests.
- **HTTP/2 proxy**: h2c listener (auto-detects h1/h2), hyper-based upstream client with trailer forwarding, `GrpcProxyBody` for proper trailer delivery.
- **Synth detection**: `is_grpc_endpoint()`, method-name state op inference (Create/Get/List/Update/Delete), `grpc` flag on RouteModel. 22 tests.
- **Serve handler**: `GrpcConfig` loads proto descriptors, decodes protobuf requests, encodes protobuf responses. Trailers-only format for unary RPCs.
- **Codec wired into pipeline**: synth decodes protobuf bodies to JSON before anti-unification; check decodes recorded protobuf before diffing. Real templates, not echo fallback.
- **`X-Wraith-Format: json`**: debug header bypasses protobuf encoding, returns raw JSON from synth handler.
- **`X-Wraith-*` headers stripped** before forwarding to upstream during recording.
- **Go test service**: 6 RPCs (CRUD + streaming), all proto types (nested, enum, oneof, map, repeated, timestamps). Dockerfile for podman.
- **Validated on etcd**: real-world gRPC KV service, 3 routes, 0 divergences.

### Conformance engine improvements

- **Granular list-body suppression**: suppress only array contents, not entire envelope. Scalar envelope fields (count, summary, pagination) compared normally.
- **Numeric value comparison**: `50` and `50.0` treated as equal (f64 comparison).
- **Empty-string ID mapping fix**: prevented path corruption during conformance replay. Fixed Stripe (95->0) and PocketBase (168->0, FAIL->PASS).
- **User field classifications override all auto-detection**, including list-body suppression.

### Lua handlers

- **`check --in-memory` loads Lua with state**: `handle_request_sync` now calls `invoke_handler_with_state`. Lua handlers get full `state.*` and `clock.*` access.
- **OrderLedger stress test**: 5 patterns (computed totals, conditional shapes, list aggregates, state machine, cross-entity joins). 7 handlers. 2 divergences with Lua vs 185 without.

### Other

- **`POST /__wraith/new-session`**: force recording session boundary without restarting proxy.
- **Cross-session re-recording**: Cloudflare, GitHub, Odoo, Stripe, Linear re-recorded with 2+ sessions each.
- **GitHub GraphQL v4**: 16 operations (fragments, anonymous queries, inline fragments, deep nesting, mutations).
- **Updated docs**: twin-lifecycle.md rewritten, configuration.md expanded, quickstart updated.

---

## v0.2.0 - 2026-03-27

**15 APIs at zero divergences. 53/53 sessions passing.**

REST (13): Cloudflare, Forgejo, Gitea, GitHub, GitLab, Keycloak, Mattermost, Notion, Odoo, PocketBase, Stripe, Supabase, Twilio.
GraphQL (2): Linear (19 ops), Saleor (16 ops, anonymous queries).

### Highlights

- **GraphQL operation routing**: Detects GraphQL endpoints, splits single `POST /graphql` route into per-operation variants with guards. Handles both named operations (`operationName` field) and anonymous queries (parsed root field). New `QueryRootField` guard predicate.
- **Header allowlist**: Replaced 40+ entry blocklist with 3-entry allowlist (content-type, www-authenticate, proxy-authenticate). Opt-in via `with_extra_compare_headers()`.
- **Divergence suppression**: `[[diff.suppress]]` in wraith.toml for user-declared suppression rules with glob patterns. `--show-suppressed` flag lists distinct suppressed paths with reasons.
- **Transparent heuristics**: Hex color normalization, search/list-like body classification, scalar clobber guard - all reported as suppressed, not hidden.
- **Session tagging**: `wraith record --tag` + `wraith synth --tag` for selective synthesis.
- **Recording control plane**: `/__wraith/health`, `/__wraith/ready`, `/__wraith/info` endpoints during recording.
- **Agentic route fixer**: 5 modules, 12 tools, text-based TOOL_CALL protocol. Verified end-to-end.
- **Lua handler sandbox**: Full state API (get/put/delete/list/query/count/counter + clock), hot reload, doctor validation.
- **Synth default changed to `synth` fidelity** (was `strict`).

### Engine fixes (0.1.x -> 0.2.0)

- Scalar clobber guard: don't overlay entity scalar onto template compound type
- Search/list-like classification: POST search + bare array -> Generated body
- Hex color heuristic: `#e11d48` vs `e11d48` suppressed
- Variant routing guards (PathSegmentEquals, PathSegmentPrefix, FieldEquals, QueryRootField)
- Dynamic-key object map suppression
- Order-independent array matching
- Heuristic timestamp/counter suppression
- Empty-body response handling
- Non-JSON content echo (binary/HTML/text strict replay)
- Gzip decompression in conformance normalizer
- 30+ additional deterministic fixes across 5 days
