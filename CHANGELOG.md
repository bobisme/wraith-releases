# Changelog

## v0.14.0 — 2026-06-26

**Editor autocomplete for `wraith.toml` and `scrub.toml`, reliability fixes across conformance and serving, and an experimental opt-in way to model collections whose element shape depends on a sibling field.** New twins get config autocomplete for free; existing twins re-synth and re-serve unchanged.

### What changed for you

- **Config autocomplete and validation.** `wraith.toml` and `scrub.toml` now have published JSON Schemas, and `wraith init` writes a `#:schema` line at the top of each new config file. Editors with TOML support (anything backed by Taplo — VS Code's Even Better TOML, Zed, Neovim, …) pick it up automatically for key completion, inline docs, and error highlighting. For an existing config, copy the `#:schema` header from a freshly `wraith init`'d file.
- **Fewer false conformance failures and cleaner replays.** HEAD requests no longer return a body; state-backed reads keep their dynamic response headers; reading an object from unseeded state returns the recorded success response instead of a spurious 404; and structural IDs in path segments are turned into route parameters more reliably. Credit-card scrubbing no longer mangles UUIDs, and Lua-handler output is passed through untouched.
- **Clearer Lua handler binding.** Handler files named with hyphens or camelCase now match their routes (normalized to snake_case), `wraith init` drops in a naming-convention README, and `wraith serve` warns when a handler you loaded binds to zero routes — so a misnamed file no longer fails silently.
- **(Experimental) dependent-case modeling.** For collections where one field's *shape* depends on a sibling discriminator — e.g. a Stripe event's `data` shape depends on its `type`, or a GitHub event's `payload` on its `type` — Wraith can now model each case separately. It is **off by default** and only applies to the route + field pairs you explicitly list under `[generate.dependent_cases]` in `wraith.toml`, so nothing changes unless you opt in.

### Should I do anything?

Nothing required. Re-run `wraith init` (or copy the `#:schema` header) to get config autocomplete in your editor, and re-run `wraith synth` / `wraith generate` to pick up the conformance fixes. The dependent-case feature is opt-in only.

## v0.13.0 — 2026-06-24

**Wraith now models APIs that return mixed collections of different object types — like Stripe's event stream — instead of flattening them into one lossy shape.** When an array or nested field holds different resource types selected by a discriminator (e.g. each Stripe event's `data.object` is a `customer`, a `price`, a `product`, …), Wraith learns a separate schema for each case. Type-specific fields that used to vanish because they were rare across the whole collection are preserved, and conformance compares each element against its own type. On the Stripe events endpoint this removes about 555 false "missing field" failures. The feature turns on automatically only where it applies — homogeneous lists and existing twins are unchanged.

### What changed for you

- **Heterogeneous collections are modeled per type.** Wraith detects when a collection's elements (or a nested object) vary by a discriminator field (`object`, `type`, `kind`, `__typename`, …) and synthesizes a schema for each observed type. A field that only appears on one type — say `unit_amount` on a `price` — is no longer dropped just because it's rare across the whole list.
- **More accurate conformance on mixed lists.** `wraith check` matches each element to its type before comparing, so a reordered or differently-sampled collection no longer produces spurious missing/extra-field noise. Clearer divergences now call out an unknown or missing type tag instead of a wall of field mismatches.
- **Control over types you haven't recorded.** Real APIs keep adding new event and resource types. By default Wraith flags an unrecorded type as a divergence (fail-closed), and `wraith check` tells you which type it saw. You can relax this per route in `wraith.toml`:
  ```toml
  [[diff.tagged_union_policy]]
  route = "GET /v1/events"
  policy = "fallback_common_schema"   # or "replay_representative"
  ```

### Should I do anything?

Re-run `wraith synth <twin>` (and `wraith generate <twin>`) to pick up per-type modeling for any heterogeneous collections in your API. Nothing else changes — recordings, models, and `wraith.toml` are all compatible, and homogeneous APIs are unaffected.

## v0.12.0 — 2026-06-24

**`wraith generate` is now free and deterministic by default — no LLM, no API keys, no tokens — and twins reproduce far more of an API's real responses out of the box.** Running `wraith generate <twin>` now repairs your twin using only the recordings it already has; the optional LLM pass is opt-in behind `--llm`. Across Wraith's 23-API test corpus, every twin now passes conformance from `wraith synth` + `wraith generate` alone, with no LLM in the loop. No config or wire-format changes — existing twins re-synth and re-serve unchanged.

### What changed for you

- **`wraith generate` no longer needs an LLM provider.** By default it runs only the deterministic repair pass — instant, free, and reproducible, with nothing to set up. If you relied on the model-fixing LLM pass, add `--llm` (and configure a provider) to turn it back on; when divergences remain after the free pass, the output tells you to re-run with `--llm`. Old flags still work: `--agentic` now implies `--llm`, and `--cegis-only` is simply the new default.
- **Twins reproduce derived URLs and IDs correctly.** Fields built from other values — a resource URL that splices in a name from your request, or one that embeds the response's own generated ID (e.g. a Notion page URL like `…/Title-Slug-<id>`) — are now reproduced as live derived values instead of a frozen recorded string. These used to show up as drift on every replay; now they track the request and the generated ID, including for URLs inside list elements.
- **Fewer false conformance failures.** `wraith check` now recognizes values a twin legitimately can't reproduce byte-for-byte and compares them by shape: server-side hash tokens inside URLs (avatar hashes, signed-URL tokens, content hashes) and timestamps (any two valid RFC-3339 datetimes). It also preserves server-added fields when you read back an object you created with a sparser request, and compares list/query result arrays without tripping on length.
- **Smaller models for path-heavy APIs.** Synthesis now folds slug and name path segments (like `/repos/:owner/:repo/…`) into route parameters instead of creating one route per value, so models for large APIs are dramatically smaller.

### Should I do anything?

Re-run `wraith generate <twin>` to pick up the new deterministic repairs — it's free now. If your workflow set `--agentic` or expected the LLM pass by default, switch to `--llm` to keep it. Nothing else changes: recordings, models, and `wraith.toml` are all compatible.

## v0.11.1 — 2026-06-18

**Patch release. `wraith up` now stops cleanly on Ctrl+C everywhere.** On macOS and BSD, pressing Ctrl+C on `wraith up` left the twins running and the foreground hung — the shutdown path keyed off a Linux-only liveness check, so it never signalled the child twins. Shutdown is now portable: a single SIGINT stops every twin and `up` exits in about a tenth of a second with no orphaned processes. Linux behavior is unchanged (and a rare hang on a recycled PID is gone too). No config or wire-format changes.

## v0.11.0 — 2026-06-18

**Live request logs in `wraith up`.** Running `wraith up` used to print a status table and then sit silent while it streamed every twin's output to a log file — you had no idea what was hitting your twins until you went digging. Now the foreground shows a live, color-coded request log, `docker compose up`-style, with one line per request. Purely additive — no wire formats change, and the log is default-on but easy to silence.

### What you can do now

- **See every request as it happens.** `wraith serve` emits one access line per request — method, path, status, duration, and the matched route template — across synth, strict, and fuzzy modes. On a terminal you get a compact human line like `200 GET  /v1/customers/cus_123  4ms  (route: /v1/customers/:id)`; piped into CI you get one JSON object per line. Control it with `--access-log compact|json|off` (default-on, independent of `--trace`; auto-picks compact for a TTY and JSON for a pipe).
- **Watch all your twins at once.** `wraith up` interleaves each twin's requests into one stream with an aligned, color-coded `<twin> | …` prefix, while still teeing the raw lines to `.wraith/logs/<twin>.log` for `wraith down` and post-mortems. A terminal gets compact lines, CI gets JSON — decided once, for every twin.
- **Read a clean foreground.** `wraith serve`'s own startup and shutdown logs now render in the same compact, color-coded format on a terminal instead of a wall of JSON, so the request lines stand out. Piped output stays all-JSON for both tracing and access lines.

## v0.10.0 — 2026-06-16

**Intent contracts.** A consumer can now hand a provider an executable statement of what they depend on — packaged as a signed `.wic` archive that pins the twin by digest and carries runnable scenarios — and the provider verifies it against a freshly composed twin in CI. Purely additive: every v0.9.x pack, composite, and `wraith.toml` re-verifies and re-serves unchanged, and root and overlay twins are untouched. The whole surface is the new `wraith contract` command group. See the [Intent contracts](/contracts/) guide for the full workflow.

### What you can do now

- **Author a contract.** `wraith contract pack ./staged --output checkout-refund.wic --key ./signing.key` assembles a deterministic, signed `.wic`: it pins the base (and any overlay) twin by digest, bundles your sigil Lua scenarios plus the canonical `lib/wraith.lua` helper, and PII-scans the bundle before sealing it (override knowingly with `--override-pii <reason>`). Pack twice → byte-identical.
- **Inspect before you trust.** `wraith contract inspect <pkg>.wic` summarizes a package; `--strict` runs the trust-gate lint and rejects anything whose PII scan isn't clean.
- **Verify against your own twin.** `wraith contract verify <pkg>.wic --base-pack base.wraith --overlay-pack overlay.wraith` resolves the pinned artifacts to your local packs, composes and serves the twin, runs the scenarios through `sigil`, and reports a CI-ready envelope. Structured exit codes: `0` pass, `2` contract failed, `3` digest/signature, `4` runtime. `--pack-dir <dir>` auto-resolves pins by digest; an unmet pin names the digest it needs.
- **Accept through a trust gate.** `wraith contract accept <pkg>.wic --trust-store ./trusted-signers` checks the signature against keys you trust, materializes the runnable scenarios, and records the decision in a `<name>.status.toml` sidecar you commit with your code. Non-default evidence modes, extra capabilities, and non-self-contained packages each need an explicit `--allow-…` flag. Re-accepting a contract that already has a decision is refused unless you pass `--force`, so a re-accept can never silently undo a `reject` or `suspend`.
- **Decide how a contract gates CI.** `set-status advisory|accepted|blocking` is the dial — `advisory` runs but never fails CI, `accepted` warns, `blocking` makes a violation a hard failure. `reject` and `suspend` record the two "not installed" decisions. `status` and `list` read back where everything stands (both default to the installed view).
- **Check a contract against a base bump.** `wraith contract rebase-check` classifies a contract against a new base digest (`compatible` / `additive-safe` / `conflict`) so you can tell whether a base change breaks a downstream expectation without re-recording.

### How the pieces fit

A contract carries three independent dials so the consumer's intent, each scenario's maturity, and the provider's gating decision never collide: **consumer_status** (`observed` / `proposed` / `deprecated`, in the signed `.wic`), each scenario's **lifecycle_state** (`draft` → `canary` → `active` → `quarantined` → `retired`), and the provider's **provider_status** dial (`advisory` / `accepted` / `blocking`, plus the not-installed `rejected` / `quarantined`, in the unsigned sidecar). The sidecar keeps an honest audit trail: `accepted_by` is the original accepter (set once), while `decided_by` names whoever made the latest decision — so a rejected contract shows both who first accepted it and who rejected it.

### Privacy by default

The default evidence mode is `reference_only` — a contract carries scenarios and digests, not your captured traffic. Scrubbed-excerpt and full-recording modes exist but must be admitted explicitly at accept time, and the choice is recorded in the sidecar.

## v0.9.1 — 2026-06-05

**Overlay flow hardening.** Patch release shaking out the v0.9.0 overlay workflow against real-corpus twins. No wire-format changes — v0.9.0 packs and composites re-verify and re-serve unmodified.

### Things that just work now

- **`wraith serve --overlay <ovl.wraith> --overlay-policy <path>`** — local workspace overlays compose against a relaxed policy without forcing you to sign every iteration. Pass a policy file that allows unsigned overlays and adds your overlay's scrub-policy hash to `allowed_scrub_policy_hashes`.
- **`wraith compose` outputs survive `wraith doctor`.** The composite now carries `scrub.toml` and a populated `schema_version` so doctor stops rejecting freshly-composed workspaces as "missing security policy."
- **`wraith init --base provider@sha256:<hex>`** — the embedded `artifact = "name@sha256:..."` form that `--help` and the Overlays guide already documented now actually parses out of `[base]` in `wraith.toml`. The legacy split `digest = "..."` field still works.
- **`wraith doctor <path-to-workspace>`** accepts literal workspace paths the same way `wraith serve` does, instead of demanding a twin name resolvable under `twins/`.
- **`wraith serve --fixture <overlay-name>`** accepts the bare overlay suffix as a fallback when the namespaced form is omitted, matching what the help text already promised.

### Reporting that doesn't contradict itself

- **`wraith synth --delta` JSON summary** now carries `new_routes`, `synthesized_overlay_exchanges`, and a per-reason `unreplayable_by_reason` map alongside the existing fields. Pre-fix, the headline `delta` stayed at `0` when an overlay introduced brand-new routes the base never observed — CI scripts read that as "no overlay material" even when synth emitted seven new routes. The new `synthesized_overlay_exchanges` count matches the emitted route count regardless of whether the routes are existing-route deltas or brand-new surfaces.
- **`wraith compose` advice no longer says `lint-clean` while also reporting `20 lint warning(s)`.** Round-trip success is still reported (because the round-trip itself succeeded), but the message now reflects the warning count and points at the warning-bearing advice entry.
- **`wraith compose --check`** now distinguishes "perfect conformance" from "no replay evidence." A composite with no recorded sessions surfaces `verify-check-no-evidence` instead of an unconditional 10000-bp score.
- **`compose-report.json` variant counts** at the top level now agree with per-overlay counts for overlay-added routes.

### Strict pack verification is usable on public APIs again

- **`wraith verify-pack --strict`** stops flagging every `name` JSON-key literal in an anti-unified model template as PII. On synth-emitted model artifacts (`model/symbols.json`, the WIR), single-token enum values that look like slugs (`bulbasaur`, `machine`, `egg`, `platinum`) are now treated the way the runtime scrubber's cardinality filter would — suppressed structurally. Multi-token person names ("Alice Smith") still fire. Email-keyed leaves are unconditionally counted regardless of artifact because `@` is a strong self-contained shape signal. Concrete effect: on a packed PokéAPI twin, strict verify drops from ~14k findings (false positives) to 0.
- **`wraith pack --format json`** and the JSON envelope carry `content_digest` so overlay authors can read the base package digest required by `init --base <ref>@sha256:...` directly from the envelope instead of cracking the archive open.
- **Pack and verify-pack surface the overlay's scrub policy hash**, so consumers can satisfy strict compose's `allowed_scrub_policy_hashes` gate without unpacking.
- **`verify-pack` JSON envelope** surfaces composition provenance (base + overlay digests) on composite archives so you can read what a composite was made of without unpacking it.
- **`verify-pack` no longer false-positives on Wraith-authored structural provenance keys** (`artifact_name`, `twin_name`) in freshly-packed archives.

### Runtime

- **Synth-handler variant guards return a `route-no-match` error when every guard misses**, instead of silently dispatching to the first variant. Eliminates a class of confusing zero-divergence false-positive routes you might have hit when authoring guarded overlays.
- **`serve --overlay` no longer leaves composite workspaces behind** outside the tempdir when overlay paths resolve through unexpected basename shapes. `--keep-composite` still works for debugging.

### Action you might want to take

- If you scripted around `delta_filter.delta` to decide whether an overlay produced material, switch to `delta_filter.synthesized_overlay_exchanges` (or `synthesis.routes.length`). The legacy `delta` field is preserved for backward compatibility but only counts variants on existing base routes — it doesn't include brand-new routes the overlay contributed.
- If `wraith verify-pack --strict` was failing in CI on public-API twins because of `name` PII findings, you can drop any `[diff.suppress]` workarounds — strict should now pass cleanly on those.

## v0.9.0 — 2026-05-26

**Overlays.** A consumer team can layer their own routes, variants, fixtures, and fault profiles onto a provider-owned base twin without forking the base, and ship that layer as its own `.wraith` artifact. Pre-existing root twins are completely unaffected — overlays are inert without a `[base]` section in `wraith.toml`.

### Why you might want this

- You need a behavior the provider hasn't recorded (a webhook replay path, an error scenario, a specific edge case in CI).
- Your test environment needs different fixture data than the base ships.
- You want to add fault injection or latency profiles without touching the shared twin.

If you'd otherwise vendor and edit a copy of someone else's twin, you want an overlay.

```bash
wraith init checkout-billing --base billing-api@sha256:abc --owner checkout
wraith record checkout-billing --tag happy-path
wraith synth checkout-billing                              # --delta is the default
wraith compose --base billing-api.wraith \
               --overlay checkout-billing.wraith \
               --output composite
wraith serve composite
```

See [the Overlays guide](https://wraith.cx/overlays/) for the full workflow, configuration reference, and v0 scope notes.

### New commands

- **`wraith compose`** — merge a base plus one or more overlays into a materialized composite twin (a workspace or `.wraith` archive). Deterministic: same inputs in the same order produce byte-identical outputs.
- **`wraith rebase-check`** — when the base advances, classify whether your overlay still applies cleanly against the new digest without having to re-record. Emits `compatible`, `additive-safe`, or `conflict` with evidence.
- **`wraith promote`** — gated publication of an overlay artifact. Requires policy pass plus evidence sufficiency. Evidence-light overlays can still be checked, but they can't be promoted.

### New flags

- **`wraith init --base <ref> --owner <team>`** — initialize a twin as an overlay against a digest-pinned base.
- **`wraith synth --delta | --full | --base-path <path>`** — `--delta` (the default for overlay twins) synthesizes only the routes that diverge from the base; `--full` synthesizes the entire twin. Root twins always synth full.
- **`wraith serve --overlay <ovl.wraith> [--keep-composite] [--fixture <name>]`** — convenience for "compose then serve" without writing a composite to disk first. `--keep-composite` retains the materialized workspace for debugging.
- **`wraith check --fixture <name>`** — pick which overlay's fixture set seeds the default namespace during conformance.
- **`wraith pack --include-diagnostics`** — ship compose-phase diagnostics inside the packed archive's `reports/` tree.

### Safety posture

Overlay policy uses the existing exit-code discipline:

- **0** — composes cleanly.
- **1** — user error (bad config, missing artifact).
- **3** — policy violation (weaker scrub posture, base-route deletion, Lua handler shadowing, etc.).
- **4** — runtime error during composition.

### Other improvements

- **`compose` output is fully self-contained.** Composite workspaces now carry the merged `state/fixtures/` and recordings rather than referring back to the input artifacts.
- **`compose` rejects archive entries with traversal-shaped paths** (`..`, absolute paths, symlinks pointing outside the input root). Defense-in-depth on the unpack stage.
- **Same inputs to `compose` produce byte-identical artifacts.** Set `SOURCE_DATE_EPOCH` to pin timestamps further. Useful for CI that diffs `.wraith` archives.
- **`wraith synth --delta` writes `build/delta-report.json`** with a per-route breakdown of `covered_by_base` / `delta` / `unreplayable` and structured advice (`overlay-is-redundant`, `many-unreplayable`, `base-route-missing`) — gives a clear signal about whether an overlay is doing anything new or whether you should re-record.
- **`wraith lint` catches overlay misconfigurations.** Missing `[overlay].owner`, invalid base digest, mismatched capability flags, and overlay twins that try to enable passthrough are flagged with the same surface `wraith doctor` already used.

## v0.8.4 — 2026-05-21

**Patch. Search and query `POST` routes no longer mint phantom entities in state.**

POSTs like `POST /v1/assets/actions/search` were being classified as resource Create operations, so every search call left a junk entity behind in the per-session state store. After v0.8.3 wired seeded fixtures through serve, this caused three visible problems: search-shaped fixture-name collisions, faster-than-expected exhaustion of `serve.limits.max_entities_per_type`, and state snapshots polluted with synthetic search responses.

Action POSTs are now detected by two signals — the last URL segment (`search`, `query`, `count`, `aggregate`, `summarize`, `lookup`, and the Stripe-style `/actions/<verb>` shape) and the response body shape (single-array bodies or paginated `{results: [], next_cursor: …}` shapes). Routes matching either signal dispatch without state mutation.

If you have a twin where this heuristic now applies (e.g. `POST /v1/customers/search`), re-run `wraith synth` to pick up the fix.

## v0.8.3 — 2026-05-21

**Patch. `state/fixtures/` is now actually loaded at serve time.**

The `state/fixtures/<entity>.json` shape has been documented since v0.1, but `wraith serve` never read those files — every state-backed Read or List started with an empty store regardless of what was on disk. This is now wired through end-to-end.

- **Per-session seeding.** `state/fixtures/<entity_type>.json` is loaded once per `X-Wraith-Session` namespace on first use. A delete then persists for the rest of the session; no re-seeding mid-session.
- **Default namespace too.** Requests without an `X-Wraith-Session` header still get seeded.
- **`state/schema.json`** declarations merge into the route-derived schema. Route-derived wins on conflict, so an empty `entity_types: {}` (the `wraith init` default) is fully inert.
- **Fail-safe.** Missing or malformed files warn-log and proceed rather than crash `serve`. A twin with no `state/` directory behaves exactly as it did pre-v0.8.3.

**Use case.** Multi-twin demos and shared-entity test scenarios — e.g. customer `cus_123` referenced consistently across a CRM twin, a billing twin, and an orders twin — can now be set up by authoring one fixture per twin rather than driving a `POST` sequence at the start of every session.

**Heads up — outbound scrub still runs on seeded fixtures.** A fixture entity with a `name` field will be tokenized on the wire by the default PII rules (`"alpha"` → `"name_<base62>"`). This is the v0.6.0 PII behavior, not a regression — but it surprises fixture authors. Workarounds: add the field to your `[pii] allowlist` in `scrub.toml`, or set `[pii] detect = false` for twins where seeded values aren't real PII.

## v0.8.2 — 2026-05-19

**Patch. Closes the remaining `$arr_N` placeholder leak on List and Read routes.**

v0.7.1 fixed Create dispatch, but nested array placeholders — e.g. `{"data":{"items":["$arr_0"]}}` or a sibling `meta` / `facets` array — still leaked through List and Read because those handlers only rewrote the top-level collection array. They're now expanded everywhere variants surface a body, so no literal `$arr_N` markers reach the wire.

If your synthesized responses include nested arrays and you saw `["$arr_0"]` in serve output before, upgrade and they're gone. No re-synth required.

## v0.8.1 — 2026-05-18

**Patch. Completes the v0.8.0 CORS preflight fix under the default config.**

v0.8.0 correctly synthesized `access-control-allow-{methods,headers}` and `vary` on the `OPTIONS` variant, but the default `strip_headers = true` config (created by `wraith init`) then stripped those exact headers on the way out because they weren't in the response-header allowlist. The v0.8.0 fix was therefore inert for most twins.

`access-control-allow-methods`, `access-control-allow-headers`, `access-control-max-age`, and `vary` are now in the default allowlist. Cross-origin clients hitting a synth twin behave correctly under `strip_headers = true`. Conformance scoring is unaffected.

## v0.8.0 — 2026-05-18

**Feature release. Closes three rough edges that came up in real-corpus use: dropped CORS preflight headers, repetitive array elements, and routes whose response depends on a request field. Every new behavior is opt-in or a strict bugfix; pre-existing twins keep their current bytes unless you opt in.**

### CORS preflights actually work in browsers

`wraith serve --fidelity synth` returned a bare `204` for cross-origin `OPTIONS` preflights, dropping `access-control-allow-{origin,methods,headers}` and `vary`. Every browser request was therefore blocked at the preflight stage. The synthesized `OPTIONS` variant now carries the recorded CORS headers, body-less status groups (204 / 304) included. Strict-mode replay was already correct; synth now matches.

### Configurable array-element variety

`array_length = "p90"` (v0.7.2) recovered a ~500-long array but anti-unification still capped the *distinct elements* at 8 and tiled them to length — list UIs showed 8 rows repeated ~62×.

```toml
[generate.anti_unification]
max_array_representatives = "all"   # or a bound like 200
```

Default stays at `8` so existing twins are byte-unchanged. Catalog or search APIs whose recordings carry many distinct rows are the main beneficiaries.

### Request-keyed response bucketing

Some routes return different bodies depending on a *request* field — a parent id, a `useCase` scope, a search filter. Without help, synth collapses every input to one global representative, and every variation in the request returns the same canned response. The new request-keying machinery synthesizes one response per request-field bucket and routes the right one back.

```toml
[generate.request_keying]
mode = "manual"          # or "auto" for conservative auto-detection

[[generate.request_keying.route]]
route  = "POST /v1/assets/actions/search"
fields = ["$.input.filter.parentId"]
```

Default is `mode = "off"`, fully inert. Use `manual` to declare keys per-route, or `auto` to let synth try to detect a key for unruled routes when one strongly predicts the response.

### Recommended config

For catalog / search-shaped APIs that combine bimodal arrays with request-keyed responses:

```toml
[generate.anti_unification]
array_length = "p90"
drop_empty_array_responses = true
max_array_representatives = "all"

[generate.request_keying]
mode = "manual"
```

## v0.7.2 — 2026-05-15

**Feature release. Adds two knobs so synth handles bimodal / search corpora correctly. Both default to pre-v0.7.2 behavior exactly — existing twins are byte-unchanged unless you opt in.**

A debounced search endpoint records a flood of empty no-match responses interleaved with a few real catalog loads. Synth's default `median`-length array policy then collapsed such routes to ~1-element arrays even though the data was right there in the recordings.

Two new knobs, both under `[generate.anti_unification]`:

- **`array_length`** — `"median"` (default), `"p75"`, `"p90"`, or `"max"`. Pick the length statistic that matches your corpus shape.
- **`drop_empty_array_responses`** — `false` (default). When `true`, all-empty responses are excluded from anti-unification *per status group*, but only when at least one non-empty response exists for that group, so error variants and scalar responses are never dropped.

`wraith synth` now prints the active policy in its fidelity warning and, on collapse-prone defaults, suggests the exact stanza to add.

### Recommended config for bimodal / search APIs

```toml
[generate.anti_unification]
array_length = "p90"               # or "max"
drop_empty_array_responses = true
```

## v0.7.1 — 2026-05-14

**Patch. Fixes a placeholder leak in synth-mode Create responses.**

`wraith serve --fidelity synth` was returning literal `["$arr_0"]` strings in `POST` responses for routes classified as Create whose variants used variable-length array placeholders. The same string was also being persisted into state, so subsequent Read / List requests for that entity kept emitting it indefinitely.

Fixed at write time — expanded entities go into state, and expanded bodies go to clients. Re-pack any twin whose recordings include Create routes with variable-length arrays to flush the bad state from earlier serve runs.

The related nested-placeholder leak on List / Read routes is fixed in v0.8.2.

## v0.7.0 — 2026-05-13

**`wraith generate` hardening release. Four review passes on generate alone surfaced 11 fixable bugs — budgets that didn't enforce, audits that didn't write, scores that disagreed with `wraith check`, rejection reasons that hid the real cause. All fixed. The agentic and single-shot loops are now trustworthy enough to drive in CI.**

See the [v0.7.0 site changelog](https://wraith.cx/changelog/) for the full detail breakdown.

## v0.6.0 — 2026-05-11

**Brutal-review shakedown. 14 review passes, 70+ fixes, zero open bugs at cut. New wire-mode conformance, new `wraith install`, principled PII machinery.**

See the [v0.6.0 site changelog](https://wraith.cx/changelog/) for the full detail breakdown.

## v0.5.2 — 2026-05-01

**Streaming and capture fidelity. Three new fixture twins.**

### Streaming + recording

- **`wraith record` survives SIGTERM mid-stream.** Long SSE/gRPC streams cut by SIGTERM (or `wraith record stop`, vessel, systemd) now persist their WREC and session manifest with `truncated=true` instead of vanishing silently. The forward proxy now also handles SIGTERM; previously only `Ctrl-C` was caught.
- **In-flight streams pin sessions against the idle timeout.** A long SSE stream (e.g. an LLM streaming for >30s on CPU) no longer fragments surrounding exchanges into separate sessions in `wraith inspect`. Sessions close when the activity actually stops, not when the next exchange happens to start.
- **gRPC replay is byte-faithful for fixed-length arrays.** Fixed-position event slots in a recorded stream now render with the correct per-slot template instead of position 0's. No more ghost proto3 default values on the wire.
- **Synthesized 429 bodies match the route's recorded 4xx shape.** Stripe gets `{error: {type, code, message}}`, GitHub gets `{message, documentation_url}`, Twilio and GraphQL likewise. Fallback when no 4xx is recorded is a structured `{status, code, message, retry_after}` — friendlier to clients deserializing into typed error structs.
- **Volatile response headers freshly emitted at serve time.** `Date`, `Server`, `X-Request-Id`, `Cf-Ray`, `Etag` are dropped at synth time and synthesized at serve time so 200s and 429s carry the same wallclock `Date` source — important for HMAC signers and freshness checks.

### Variant routing

- **Header presence as a guard.** When a single route records both authed (200) and unauthed (401) shapes, `wraith synth` infers `HeaderPresent` / `HeaderAbsent` guards on the discriminating header (e.g. `Authorization`). At serve and check time, requests route to the matching variant. Header-name-agnostic — any consistently-present-vs-absent header qualifies.

### `wraith.toml` artifact completeness

`twin.wir.json` is the documented portable twin artifact. It used to silently drop several pieces of metadata that `wraith serve` already supported via the in-memory model. Now round-tripped:

- Per-route binary content type and body (HTML, plain text, opaque binary endpoints)
- Per-route gRPC marker
- Per-variant Lua hook handler
- Per-route symbol table
- Per-variant header programs and optional-field lists

All additions are backward-compatible — existing `twin.wir.json` files load unchanged.

### Other

- Exercise scripts force a session boundary (`POST /__wraith/new-session`) between recording iterations. Multi-session runs now produce real session boundaries instead of one giant session.
- `wraith inspect` surfaces refresh probe recordings (`recordings/refresh/<run_id>/sessions/`) alongside regular ones.

### New twins (podman fixtures)

Three streaming-fixture twins for contributors to replay end to end:

- **mercure** — pure SSE hub. Infinite-stream regression target.
- **caddy-sse** — minimal controlled SSE fixture with configurable event count, cadence, and payload shape.
- **qdrant** — vector DB gRPC twin. Validates the unary gRPC + protobuf-descriptor pipeline.

## v0.5.1 — 2026-04-30

**v0.4 shakedown follow-ups. Twin-quality fixes + lifecycle commands.**

### Twin-quality fixes

- **DELETE replay matches recorded shape.** `wraith serve` now renders the variant body template on DELETE instead of substituting a hardcoded `{deleted, id}` body. Literal fields like `object: "coupon"` survive.
- **Numeric epoch fields stay numeric.** Fields like Stripe's `created` (Unix epoch seconds, integer) are no longer overlaid with ISO 8601 strings. The classified clock unit (`epoch_sec` / `epoch_ms` / `iso_string`) drives output, not the field name.
- **No more `$hole_*` placeholder leaks.** Unfilled holes can never reach the wire under any classification. The hole classifier learns ID shape from observations: prefix, length, and character class. Stripe-shaped IDs (`cus_<14 base62>`) and short token fields (e.g. 7-char uppercase alnum) are generated correctly.
- **`/__wraith/ready` returns 200 once the listener is bound.** Previously it returned 503 forever, breaking `wraith up`'s ready poll and `wraith status`'s ready probe.
- **`wraith coverage` reports real session counts.** Previously every route showed `sessions=0`.
- **Trace ring buffer captures non-200 responses.** `--trace` now records 429s, fault-injected 5xx, throttle, drop, and timeout responses — exactly the responses you want with `--chaos-seed --trace`.

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

## v0.5.0 — 2026-04-29

**SSE and gRPC server-streaming.** Record, synthesize, serve, and conformance-check streaming APIs end to end.

### Streaming protocols

- **SSE** (`text/event-stream`): `wraith record` captures live without buffering — long-lived streams no longer deadlock the recorder. `wraith serve` emits realistic streams with per-event timing and rotating per-event content (an LLM twin emits the recorded token sequence, not one repeated character).
- **gRPC server-streaming**: `wraith record` forwards frames live with HTTP/2 trailers preserved. `wraith serve` emits frame-correct length-prefixed protobuf with `grpc-status` trailers — gRPC clients connect and stream without `Internal: missing trailers`.
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

`wraith synth` infers body-field guards on routes whose variants are discriminated by request-body string fields. Glob paths like `messages[*].content` are supported. At serve time, when multiple variants' guards match a request, `wraith serve` picks the most-specific variant — so a request that matches both a loose 200 catch-all and a tight 404 error variant routes to the 404.

A single route can mix streaming and non-streaming variants. The 200 SSE variant serves a stream; the sibling 404 invalid-model JSON variant serves a normal response.

### New twins

- **ollama** — twins the OpenAI-compat `/v1/chat/completions` endpoint with `stream: true` for any local Ollama model. See the [Streaming](/streaming/) guide.
- **etcd-streaming** — extends the etcd twin with `KV.Watch`, the canonical server-streaming RPC.

Both ship with podman fixtures so contributors can replay end-to-end.

## v0.4.0 — 2026-04-21

**Faulty-service simulation + OpenAPI seed + trace endpoints. Six orphan subsystems wired into the CLI.**

### Realistic simulation in `wraith serve`

- **Fault injection** (`--fault-profile <path>`, `--chaos-seed <u64>`): six fault types (Error / Delay / Timeout / Drop / Throttle / Partial), deterministic seeded RNG, route globs, header matching, percentage rolls, per-rule trigger caps.
- **Latency simulation** (`--latency-mode fixed|uniform|recorded|normal|percentile`): per-route overrides, deterministic ChaCha RNG. Fault `Delay` replaces the latency contribution for that request (no compounding).
- **Rate-limit simulation** (`--rate-limit`, `--rate-limit-override "METHOD /path=N/Wsec"`): FixedWindow + SlidingWindow, standard `X-RateLimit-*` + `Retry-After` headers. Shared 429-response builder used by both fault Throttle and rate-limit gate.
- **Evaluation order**: rate-limit → fault → latency → dispatch. All three are opt-in; zero overhead when disabled.

### Trace endpoints (`--trace`)

- `GET /__wraith/trace/log`, `GET /__wraith/trace/<id>`, `POST /__wraith/trace/reset`.
- Bounded ring buffer, same control-plane auth as the rest of `/__wraith/*`.

### Drift classification in `wraith check`

- Stable `drift_id` + `DriftType` per divergence. JSON envelope adds `drifts[]` summary (additive only).
- `twins/<name>/drift.toml` for `[[suppress]]` + `[[reclassify]]` hints matched by glob.

### OpenAPI seed mode

- New `wraith explore --from-openapi <spec.yaml> [--against <url>]`: parses OpenAPI 3.x, generates scenarios, optionally executes against a live URL.
- `wraith coverage --openapi <spec>` reports spec-vs-recordings gaps.

### Bug fixes

Router backtracking, scrub null handling, x-* header allowlist, sync conformance query-params, VCR base64 case, async CRUD error short-circuit, async/sync CRUD divergence eliminated (-561 LOC), clock holes carry unit info.

### Stats

1991 lib tests passing (+43 vs v0.3.0). 40+ new integration tests.

---

## v0.3.0 — 2026-03-30

**18 twins (REST + GraphQL + gRPC). All PASS. Honest conformance with granular suppression.**

### gRPC support (full pipeline)

- **Protobuf codec**: decode (wire→JSON) and encode (JSON→wire) via prost-reflect. 14 tests.
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
- **Empty-string ID mapping fix**: prevented path corruption during conformance replay. Fixed Stripe (95→0) and PocketBase (168→0, FAIL→PASS).
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

## v0.2.0 — 2026-03-27

**15 APIs at zero divergences. 53/53 sessions passing.**

REST (13): Cloudflare, Forgejo, Gitea, GitHub, GitLab, Keycloak, Mattermost, Notion, Odoo, PocketBase, Stripe, Supabase, Twilio.
GraphQL (2): Linear (19 ops), Saleor (16 ops, anonymous queries).

### Highlights

- **GraphQL operation routing**: Detects GraphQL endpoints, splits single `POST /graphql` route into per-operation variants with guards. Handles both named operations (`operationName` field) and anonymous queries (parsed root field). New `QueryRootField` guard predicate.
- **Header allowlist**: Replaced 40+ entry blocklist with 3-entry allowlist (content-type, www-authenticate, proxy-authenticate). Opt-in via `with_extra_compare_headers()`.
- **Divergence suppression**: `[[diff.suppress]]` in wraith.toml for user-declared suppression rules with glob patterns. `--show-suppressed` flag lists distinct suppressed paths with reasons.
- **Transparent heuristics**: Hex color normalization, search/list-like body classification, scalar clobber guard — all reported as suppressed, not hidden.
- **Session tagging**: `wraith record --tag` + `wraith synth --tag` for selective synthesis.
- **Recording control plane**: `/__wraith/health`, `/__wraith/ready`, `/__wraith/info` endpoints during recording.
- **Agentic route fixer**: 5 modules, 12 tools, text-based TOOL_CALL protocol. Verified end-to-end.
- **Lua handler sandbox**: Full state API (get/put/delete/list/query/count/counter + clock), hot reload, doctor validation.
- **Synth default changed to `synth` fidelity** (was `strict`).

### Engine fixes (0.1.x → 0.2.0)

- Scalar clobber guard: don't overlay entity scalar onto template compound type
- Search/list-like classification: POST search + bare array → Generated body
- Hex color heuristic: `#e11d48` vs `e11d48` suppressed
- Variant routing guards (PathSegmentEquals, PathSegmentPrefix, FieldEquals, QueryRootField)
- Dynamic-key object map suppression
- Order-independent array matching
- Heuristic timestamp/counter suppression
- Empty-body response handling
- Non-JSON content echo (binary/HTML/text strict replay)
- Gzip decompression in conformance normalizer
- 30+ additional deterministic fixes across 5 days

---

## Conformance Progress

### 2026-03-25 — 98% sessions passing, 6 APIs at 100%, variant routing guards

**168/172 sessions passing across 8 APIs. 275 total divergences (was 279).**

| API | Sessions | Score | Divs |
|-----|----------|-------|------|
| Odoo | 29/29 | 100% | 0 |
| GitHub | 8/8 | 100% | 1 |
| Mattermost | 48/48 | 100% | 135 |
| Keycloak | 16/17 | 94% | 4 |
| Stripe | 25/28 | 89% | 59 |
| Gitea | 28/28 | 100% | 51 |
| Cloudflare | 9/9 | 100% | 5 |
| Twilio | 5/5 | 100% | 20 |

Variant routing guard inference (bn-1ygc):
- `PathSegmentEquals` and `PathSegmentPrefix` guards inferred during synth
- Handler evaluates path-segment guards at request time for correct variant selection
- Stripe GET /v1/:param/:param gets 8 resource-type guards (customers, charges, etc.)
- Per-twin `split_variants = true` in wraith.toml [diff] section — no global flag needed
- Gitea 27/28 → 28/28 with variant splitting enabled per-twin

### 2026-03-25 — 97% sessions passing, 5 APIs at 100%

**167/172 sessions passing across 8 APIs. 279 total divergences (was 418).**

| API | Sessions | Score | Divs |
|-----|----------|-------|------|
| Odoo | 29/29 | 100% | 0 |
| GitHub | 8/8 | 100% | 1 |
| Mattermost | 48/48 | 100% | 135 |
| Keycloak | 16/17 | 94% | 4 |
| Stripe | 25/28 | 89% | 59 |
| Gitea | 27/28 | 96% | 55 |
| Cloudflare | 9/9 | 100% | 5 |
| Twilio | 5/5 | 100% | 20 |

3 deterministic engine fixes (+4 sessions, -139 divergences):
- Warning-severity divergences (extra_field, array_length_mismatch) excluded from exchange scoring — benign divergences no longer fail exchanges
- Counter heuristic extended to `_counter` suffix (was only `_count`)
- Optional field detection scans body fields absent from template, not just template fields absent from bodies
- Re-synth with improved anti-unification produces tighter models

### 2026-03-24 — 95% sessions passing, 3 APIs at 100%, Lua handlers + variant routing

**163/172 sessions passing across 8 APIs. 418 total divergences (was 3184).**

| API | Sessions | Score | Divs |
|-----|----------|-------|------|
| Odoo | 29/29 | 100% | 6 |
| GitHub | 8/8 | 100% | 1 |
| Mattermost | 48/48 | 100% | 179 |
| Keycloak | 16/17 | 94% | 6 |
| Stripe | 24/28 | 86% | 128 |
| Gitea | 26/28 | 93% | 57 |
| Cloudflare | 8/9 | 89% | 21 |
| Twilio | 4/5 | 80% | 20 |

Lua handler integration (bn-2d8w goal, all 5 sub-bones complete):
- Routing: lua_hook field on VariantModel, handlers in twins/<name>/lua/handlers/
- Dispatch: both sync (conformance) and async (serve) paths
- State API: state.get/put/delete/list/query/count/counter + clock.now/advance
- Doctor: wraith doctor validates handler compilation
- Hot reload: reload_lua_handlers() re-scans without restart
- E2E verified: Keycloak GET / serves HTML via Lua, synth handles rest
- Full docs: docs/twin-lifecycle.md covers record→synth→check→generate→lua→serve

Variant routing (experimental, `wraith synth --split-variants`):
- Discriminator detection: finds type/object/kind fields that partition responses
- Per-type variants: anti-unifies each group separately (e.g. 8 Stripe resource types)
- Best-match selection: conformance check tries all same-status variants, picks fewest divergences
- Gated behind flag: re-synth without the flag produces identical models (no regressions)

Engine improvements:
- Ignore all x-* headers by default (vendor extensions rarely affect correctness)
- Per-twin ignore_headers in wraith.toml for non-x vendor headers
- Cleaned DEFAULT_IGNORED_HEADERS (removed 32 now-redundant x-* entries)

### 2026-03-23 — 96% sessions passing, 4 APIs at 100%

**165/172 sessions passing across 8 APIs (+22 sessions from 83%).**

| API | Sessions | Score | Delta |
|-----|----------|-------|-------|
| Odoo | 29/29 | 100% | — |
| GitHub | 8/8 | 100% | — |
| Cloudflare | 9/9 | 100% | — |
| Mattermost | 48/48 | 100% | +15 sessions (was 69%) |
| Keycloak | 16/17 | 94% | — |
| Gitea | 27/28 | 96% | +3 sessions |
| Stripe | 24/28 | 86% | +2 sessions |
| Twilio | 4/5 | 80% | +2 sessions |

11 deterministic engine fixes (no LLM involved):
- Global regression guard: generate loop rejects patches that increase total divergences
- Dynamic-key object map suppression: skip field comparison for ID-keyed maps
- Order-independent array matching: match elements by identity key before positional comparison
- Heuristic timestamp/counter suppression: auto-detect `*_at`, `*_count` fields as dynamic
- Empty-body response for null-body variants across all state ops (Create/Update/Delete)
- Array-body POST route declassification: search/names/ids endpoints no longer misclassified as Create
- Prototype array element comparison skip: single-element template arrays don't produce per-element noise
- Unmodeled error status echo: conformance check echoes recorded response for missing error variants
- Conditional created timestamp injection: only when template has created/created_at field
- Empty-body exchange echo: recorded empty body used when handler serves JSON
- Non-JSON content echo: binary/HTML/text responses use strict replay instead of template rendering

Agentic route fixer E2E validated:
- Tool-use conversation loop works end-to-end with local and cloud providers
- 12 tools, native tool_use + text fallback, stall detection, global regression guard

### 2026-03-22 — 83% sessions passing, 3 APIs at 100%

**143/172 sessions passing across 8 APIs, zero manual configuration.**

| API | Sessions | Score |
|-----|----------|-------|
| Odoo | 29/29 | 100% |
| GitHub | 8/8 | 100% |
| Cloudflare | 9/9 | 100% |
| Keycloak | 16/17 | 94% |
| Gitea | 24/28 | 86% |
| Stripe | 22/28 | 79% |
| Mattermost | 33/48 | 69% |
| Twilio | 2/5 | 40% |

17 deterministic engine fixes (no LLM involved):
- Expanded ignored headers (CSP, CORS, pagination, OAuth, location, expires, websocket)
- Long alphanumeric ID detection in route normalization (Mattermost/Keycloak)
- Classification fallback for array-element paths (`body[0].field` → `body.field`)
- Hole placeholder cleanup in synth handler output
- Gzip decompression in conformance body normalizer
- Echo-source holes classified as Generated
- Null tolerance in structural type comparison
- Prototype array suppression (single-element template arrays)
- Missing_field suppression for null-valued recorded fields
- Extra_field suppression for null-valued template fields
- Empty-body variant creation (201/204 responses)
- Content-type charset normalization
- Fixed sessions_passed hardcoded to 0 in --in-memory path

Infrastructure:
- Exercise scripts for Gitea, Mattermost, Keycloak (wraith record)

### 2026-03-17 — First multi-API validation

14/14 Stripe sessions passing (with agentic fixer).
7 APIs imported from spike corpora.

### 2026-03-15 — Agentic route fixer

CEGIS generate loop with agentic tool-use (11 tools).
OpenRouter provider for cloud model access.
Native tool_use support (Ollama, OpenRouter).
Per-route regression guard.

### 2026-03-12 — Conformance engine

Semantic diff with field classifications (Generated, TimestampLike, Echo, Constant).
In-memory conformance checking (no server needed).
Per-status-code variant grouping.
Anti-unification with hole detection.
