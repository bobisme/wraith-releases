---
title: Wraith release notes and API twin conformance progress
description: Track Wraith releases, protocol support, conformance fixes, streaming work, and local API twin reliability changes.
---

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
