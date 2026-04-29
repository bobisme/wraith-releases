# Changelog

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
