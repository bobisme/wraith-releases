---
title: Changelog
description: Release notes and conformance progress
---

## v0.5.0 -- 2026-04-29

**Streaming protocols ship. SSE and gRPC server-streaming work end-to-end: record, synthesize, serve, conformance-check.**

See the [Streaming](/streaming/) guide for the full story.

### SSE streaming

- **Capture**: tee'd live-forwarding pipeline. The proxy emits each `text/event-stream` chunk to the downstream client as it arrives from upstream and finalizes the WREC asynchronously when the stream ends. Long-lived streams (Wikipedia EventStream, infinite Mercure feeds) no longer deadlock waiting for a `collect().await` that never completes.
- **Synthesis**: per-event anti-unification with prefix / variable-middle / suffix decomposition. Suffix detection catches fixed-position-from-end events like the OpenAI `[DONE]` sentinel and the trailing `finish_reason` chunk.
- **Serve**: per-event timing replayed within the recorded p99 band; per-event hole values rotate through observed examples (an LLM twin emits the recorded token sequence, not one repeated character).
- **Reciprocal `{raw: <str>}` wrapping**: capture wraps non-JSON `data:` payloads as `{"raw": "<utf8>"}` so anti-unification has structured input; the renderer unwraps back to the literal `data: <text>` line on the wire.

### gRPC server-streaming

- **Capture**: live forwarding mirrored on the gRPC path. The proxy reads `hyper::body::Frame<Bytes>` items, dispatches Data frames to the downstream client + WREC, and routes Trailers to a separate slot the downstream `http_body::Body` impl yields after the data channel closes. HTTP/2 trailers (`grpc-status`, `grpc-message`) reach the wire correctly so gRPC clients don't see `Internal: missing trailers`.
- **Projection**: `WrecExchange::stream_events()` projects server-direction Data frames into `StreamEventKind::GrpcFrame` for both `Protocol::GrpcStream` and legacy `Protocol::Http` exchanges with `application/grpc*` content-type.
- **Synthesis**: per-variant `stream_template`, gRPC server-streaming method detection, suffix anchoring on terminal messages, byte-preserving protobuf re-encoding (empty submessages preserved on the wire when explicitly observed).
- **Serve**: protocol-aware replay materializer renders templated JSON to protobuf bytes via the route's response descriptor, wraps in length-prefixed gRPC frames, emits the trailer block.
- **Termination**: streams without `grpc-status` trailers (long-lived bidi like etcd `Watch` cancelled by client deadline) classify as `Truncated`. Replay emits no synthesised `grpc-status: 0`, matching the recording.

### Honest conformance

- **Recorded vs replayed diff** (`crates/wraith/src/conformance/streaming.rs`). The streaming check compares each recording's events against the replayed sequence with template-driven tolerance: holes type-checked, constants exact-matched, optional-vs-default handled correctly. The previous template-vs-template comparison (pre-v0.5.0) was a tautology that scored 100 % regardless of runtime correctness.
- **§F.3 PASS criteria wired**: streaming exchanges score under `score_streaming_session` with explicit handling for `EventCountMismatch`, `EventSequenceMismatch`, `EventPayloadMismatch`, `FramePositionDrift`, `TerminationMismatch`, and `TrailerMismatch`. Suppressed divergences now factor into the score, not just the report (`[[diff.suppress]]` is no longer cosmetic).
- **Per-recording target length**: replay emits exactly the same number of events as the recording it's diffed against, so length variance across recordings (LLM streams 11-22 events long) doesn't trip false count mismatches.
- **gRPC payload tolerance**: the diff decodes protobuf via the route's response descriptor before applying template tolerance. Hole-tolerated fields (etcd event keys, LLM token contents) compare on shape; constants compare on bytes.
- **Tamper-verified**: editing a single constant in `model/symbols.json` produces a divergence at the tampered position with byte-exact `actual` content. The check has no quiet failure modes for either protocol.

### Variant routing

- **Body-field guard inference**: synth groups exchanges by status, looks for request-body string fields whose value sets are disjoint across variants, emits `FieldEquals` predicates for the discriminating variants. Catch-all variants (multi-value or unguarded) remain catch-alls.
- **`[*]` array glob**: the runtime path evaluator handles `messages[*].content` paths via a tokenizer that recognises `.key`, `[N]` index, and `[*]` wildcard segments. `FieldEquals` semantics on a glob: any element at the path equals the expected value.
- **Specificity-based selection**: when multiple variants' guards match a request, the runtime picks the variant with the most predicates (and breaks ties by `status >= 400` first). A request matching both a loose `model = "tinyllama"` 200 guard and a tight `messages[*].content = "ping"` 404 guard routes to the more-specific 404.
- **Per-variant `stream_template`**: a route can mix streaming (200 SSE) and non-streaming (404 invalid-model JSON) variants. The streaming template lives on the variant, not the route — non-streaming variants of streaming routes serve a normal HTTP response.

### Bug fixes

- **Synth Create handler**: respects recorded type when filling `created` field. Bool flags (etcd `WatchResponse.created`) no longer get clobbered with epoch timestamps.
- **Anti-unify**: absent-everywhere proto3 fields drop from the template (vs. emitted as zero-valued Constants); partially-present fields mark Optional and skip default-empty values at materialize.
- **`dynamic_message_to_json`**: omits unset proto3 singular fields. Prevents phantom empty submessages from leaking into anti-unification.
- **`synth_model_to_wir`**: deserializes variant guards as `GuardPredicate` then converts via `predicate_to_wir`. Previously a schema mismatch dropped every body-field guard silently during WIR emission.
- **gRPC Watch round-trip test** replaces the placeholder `#[ignore]` at `runtime/synth_handler.rs::etcd_watch_round_trip_through_synth_pipeline` -- runs deterministically without a live cluster.

### Twins

- **Ollama LLM streaming twin**: `scripts/exercise-ollama.py` + `tests/fixtures/podman/ollama/`. Twins the OpenAI-compat `/v1/chat/completions` endpoint with `stream: true` for any local Ollama model. Real cycling token output from the served twin.
- **etcd Watch twin**: extends the existing etcd unary twin with `KV.Watch`. `tests/fixtures/podman/etcd/` brings the cluster up; `scripts/exercise-etcd.py` drives N sessions of varying mutation patterns.

### Infrastructure

- ~25 streaming-related bones merged across the v0.5.0 cycle. Lib test count: 2188 (v0.4.0) -> 2262 (v0.5.0). All integration suites green.
- `notes/streaming-design.md` is the authoritative reference: WREC schema (§B), anti-unification (§C), conformance hybrid model (§D), runtime serve (§E), test strategy (§F).

## v0.4.0 -- 2026-04-21

**Faulty-service simulation + OpenAPI seed + trace endpoints. Six orphan subsystems wired into the CLI.**

See the [Simulation](/simulation/) guide for the fault/latency/rate-limit story end to end.

### Realistic simulation in `wraith serve`

- **Fault injection** (`--fault-profile <path>`, `--chaos-seed <u64>`): six fault types (Error / Delay / Timeout / Drop / Throttle / Partial), deterministic seeded RNG, route globs, header matching, percentage rolls, per-rule trigger caps. `generate_chaos_profile` builds a realistic mix from the loaded WIR when given just a seed.
- **Latency simulation** (`--latency-mode <fixed|uniform|recorded|normal|percentile>` + aux flags): per-route overrides, seeded ChaCha RNG for deterministic replay. When a fault `Delay` rule fires, it replaces the latency simulator's contribution for that request (no compounding).
- **Rate-limit simulation** (`--rate-limit`, `--rate-limit-override "METHOD /path=N/Wsec"`): FixedWindow and SlidingWindow algorithms, standard `X-RateLimit-*` + `Retry-After` headers, shared 429-response builder used by both fault `Throttle` and the rate-limit gate.
- **Evaluation order**: rate-limit -> fault -> latency -> dispatch. All three layers are `Option<Arc<...>>` -- zero overhead when their flags are absent.

### Trace endpoints (`--trace [--trace-capacity N]`)

- `GET /__wraith/trace/log` returns the ring buffer in reverse-chronological order.
- `GET /__wraith/trace/<id>` fetches a single trace by id.
- `POST /__wraith/trace/reset` clears the buffer.
- Bounded ring buffer with FIFO eviction. Same control-plane auth policy as the existing `/__wraith/*` surface. Disabled by default.

### Drift classification in `wraith check`

- Each divergence gets a stable `drift_id` (fingerprint) and a `DriftType` classification (schema-change / field-removed / status-shift / etc.).
- JSON envelope adds a `drifts[]` summary grouping divergences by `drift_id`, and per-divergence `drift_id` + `drift_type`. Additive only -- existing consumers see the old shape when `skip_serializing_if` suppresses empty fields.
- `twins/<name>/drift.toml` (sibling of `scrub.toml`) supports `[[suppress]]` and `[[reclassify]]` rules matched by glob on `drift_id` / `route` / `path` / `drift_type`. Absent file is a silent no-op.
- Refresh integration deferred until refresh's probe-execution path lands.

### OpenAPI seed mode

- New `wraith explore --from-openapi <spec.yaml> [--against <url>]`: parses OpenAPI 3.x (YAML or JSON), generates scenario plans, optionally executes them against a live URL and reports per-step match/mismatch/error counts. Auth via repeated `--header` flags.
- `wraith coverage --openapi <spec>` extends coverage to report spec-vs-recordings gaps (`covered_count`, `total_count`, `uncovered_operations`).
- Additive JSON envelope fields -- no breaking changes to existing coverage consumers.

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

## v0.3.0 -- 2026-03-30

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

## v0.2.0 -- 2026-03-27

**15 APIs at zero divergences. 53/53 sessions passing.**

REST (13): Cloudflare, Forgejo, Gitea, GitHub, GitLab, Keycloak, Mattermost, Notion, Odoo, PocketBase, Stripe, Supabase, Twilio.
GraphQL (2): Linear (19 ops), Saleor (16 ops, anonymous queries).

### Highlights

- **GraphQL operation routing**: Detects GraphQL endpoints, splits single `POST /graphql` route into per-operation variants with guards. Handles both named operations (`operationName` field) and anonymous queries (parsed root field). New `QueryRootField` guard predicate.
- **Header allowlist**: Replaced 40+ entry blocklist with 3-entry allowlist (content-type, www-authenticate, proxy-authenticate). Opt-in via `with_extra_compare_headers()`.
- **Divergence suppression**: `[[diff.suppress]]` in wraith.toml for user-declared suppression rules with glob patterns. `--show-suppressed` flag lists distinct suppressed paths with reasons.
- **Transparent heuristics**: Hex color normalization, search/list-like body classification, scalar clobber guard -- all reported as suppressed, not hidden.
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
