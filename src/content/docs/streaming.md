---
title: Mock SSE and gRPC streaming APIs locally
description: "Record, synthesize, serve, and conformance-check SSE and gRPC server-streaming APIs with deterministic local Wraith twins."
---

`wraith` records, synthesizes, serves, and conformance-checks streaming APIs the same way it does unary REST. Two wire formats are first-class:

- **SSE** (`text/event-stream`): LLM chat completions, change feeds, server-pushed updates.
- **gRPC server-streaming**: etcd `Watch`, change-data-capture, long-poll-shaped RPCs. (Bidirectional gRPC is recorded server-streaming-style: client open + N server messages + close.)

The pitch: **twin your LLM streaming for $0 in CI; twin your watch RPC for local dev**. Pointing your client at the served twin gives you deterministic, fast, faithful streaming responses without paying the upstream API or running its infrastructure.

## Quickstart: SSE

```sh
# Record a real OpenAI-compat chat-completions endpoint behind the proxy
wraith init my-llm --base-url http://localhost:11435
wraith record my-llm --port 8090 &
curl -N -X POST http://localhost:8090/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"tinyllama","stream":true,"messages":[{"role":"user","content":"hi"}]}'
# … several sessions to give synth varied data …

wraith synth my-llm
wraith serve my-llm --port 8091
```

The served twin emits a real SSE stream with `data: {...}\n\n` frames at realistic per-event intervals that any OpenAI-compat client (Python `openai`, `httpx`, raw curl) consumes natively.

## Quickstart: gRPC server-streaming

```sh
# etcd is the canonical fixture
podman run -d --rm --name etcd -p 12379:2379 quay.io/coreos/etcd:latest \
  /usr/local/bin/etcd \
  --listen-client-urls http://0.0.0.0:2379 \
  --advertise-client-urls http://0.0.0.0:2379

wraith init etcd --base-url http://localhost:12379
wraith record etcd --port 18380 &

# Drive a Watch in one shell, mutate keys in another
grpcurl -plaintext -d '{"create_request":{"key":"L3Rlc3Qv","range_end":"L3Rlc3Q0"}}' \
  -proto twins/etcd/proto/rpc.proto \
  127.0.0.1:18380 etcdserverpb.Watch/Watch &
grpcurl -plaintext -d '{"key":"L3Rlc3QvazA=","value":"djA="}' \
  -proto twins/etcd/proto/rpc.proto \
  127.0.0.1:18380 etcdserverpb.KV/Put

wraith synth etcd
wraith serve etcd --port 8081
```

The served twin emits length-prefixed protobuf frames with the correct HTTP/2 trailers (`grpc-status`, `grpc-message`) that any gRPC client unmarshals identically to the upstream.

## How streaming conformance works

The conformance check is **honest** for streaming: it compares the runtime's replayed events against the actual recorded events for each session, with template-driven tolerance for variable content.

Per [streaming-design §F.3], a streaming exchange passes when:

- Event count matches the recording exactly (per-recording target length).
- Per-event structural shape matches: keys present, types agree, constants exact-match.
- Hole-marked fields tolerate value variance (LLM token text and etcd event keys legitimately differ per request).
- Termination shape matches (clean / truncated / error).
- gRPC trailers compare via header allowlist (`grpc-status`, `grpc-message`).
- Per-event timing is within the synthesized p99 band (warning, not failure).

The hybrid model means an LLM stream emitting different tokens on each replay still passes (tokens are holes), but a stream that drops a structural field or returns the wrong number of events will fail with a localized divergence pointing at the exact path.

## Verifying honesty: the tamper test

A direct way to confirm a twin's check is genuinely catching divergences (not silently passing):

```sh
# Capture baseline
wraith check my-llm --in-memory --format json | jq '.conformance.divergence_count'

# Tamper one constant in the synth model
cp twins/my-llm/model/symbols.json /tmp/baseline.json
# Edit symbols.json: change a known Constant value (e.g. an event_type)

# Re-check. Divergences should fire at the tampered position
wraith check my-llm --in-memory --format json --show-suppressed

# Restore
cp /tmp/baseline.json twins/my-llm/model/symbols.json
```

If the tampered run shows the same divergence count as baseline, the diff is vacuous somewhere. File an issue. With wraith's streaming pipeline, tamper divergences localize byte-exactly to the path you changed.

## What gets synthesized

For each streaming route:

- **Stream template**: prefix events (fixed-position-from-start) + middle bucket (variable-length, anti-unified into one or more shapes) + suffix events (fixed-position-from-end, e.g. SSE `[DONE]` sentinel, gRPC closing message). Per-recording target length used at replay so 11-event and 22-event recordings each compare against their exact length.
- **Per-event holes**: fields that vary across recordings classified as holes. Hole values rotate through observed examples at replay (so an LLM stream emits the recorded token sequence, not "CCCCC" repeated).
- **Termination**: gRPC streams without trailers classify as `Truncated` (matches reality; long-lived bidi streams cancelled by client deadline never write trailers).
- **Per-variant**: streaming and non-streaming variants of the same route are split. The `200` SSE variant gets a stream template; the `404 invalid-model` JSON variant doesn't. Variant routing at serve time picks the more-specific guard, so a request matching a body-field discriminator (e.g. `model="badmodel"`) routes to the error path.

## Wire format details

### SSE

The recorder parses `text/event-stream` per the [W3C SSE spec]. `data:` lines are JSON-decoded when valid; non-JSON payloads (the `[DONE]` sentinel, raw text) round-trip via a `{raw: <utf8>}` wrapper that the renderer reciprocally unwraps to the original `data: <text>` line on the wire.

### gRPC

The recorder captures HTTP/2 `Frame<Bytes>` items live, with no buffering, so long-lived watches don't deadlock. Server-direction `Data` frames become `WrecFrame::Data`; `Trailers` map to the WREC's `trailers` slot. The serve path emits length-prefixed protobuf bytes plus an HTTP/2 `Trailer` frame with `grpc-status` and (on errors) `grpc-message`.

Bidirectional methods like etcd `Watch` are accepted as server-streaming for capture purposes. The recorder skips client-direction frames in the projection. Pure bidi (interleaved client/server messages) isn't yet supported as a distinct shape.

## Currently out of scope

- **WebSocket**: timed event replay is on the roadmap; no first-class support yet.
- **gRPC client-streaming** and **bidi-as-bidi**: server-streaming projection covers the common case (subscribe + receive), but interleaved bidi flows aren't modeled.
- **HTTP/2 server push**: not seen in any recorded twin to date.

For SOAP, JSON-RPC, Thrift, and other non-REST/non-gRPC protocols see the [protocol roadmap in CHANGELOG].

[streaming-design §F.3]: https://github.com/anthropics/wraith/blob/main/notes/streaming-design.md
[W3C SSE spec]: https://html.spec.whatwg.org/multipage/server-sent-events.html
[protocol roadmap in CHANGELOG]: /changelog/
