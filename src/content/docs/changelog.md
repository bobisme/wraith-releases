---
title: Changelog
description: Release notes and conformance progress
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
