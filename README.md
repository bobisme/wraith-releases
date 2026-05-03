# wraith

**Agent-accelerated API digital twin platform.**

Record any API. Run a verified local twin. Develop against it — fast, correct, local.

```
wraith init stripe --base-url https://api.stripe.com
wraith record stripe --port 8080
wraith synth stripe
wraith serve stripe
```

Your integration tests now run locally, deterministically, with quantitative proof that the twin matches reality.

## Install

```bash
curl -fsSL https://wraith.cx/install.sh | sh
```

The installer downloads the latest public binary release from
`bobisme/wraith-releases`, verifies its SHA-256 checksum, and installs `wraith`
into `/usr/local/bin` or `~/.local/bin`.

Current prebuilt targets:

- `x86_64-unknown-linux-gnu`
- `aarch64-apple-darwin`

See [Installation](https://wraith.cx/installation/) for version pinning and
manual install details.

## What wraith does

Integration tests against real third-party APIs are expensive, slow, flaky, and silently go stale. wraith solves this with a closed loop:

```
record → synthesize → verify → repair → repeat
```

- **record**: proxy-capture real API traffic into deterministic recordings
- **synthesize**: build a behavioral model (anti-unification + field classification)
- **serve**: run the twin as a local HTTP server with identical semantics
- **check**: conformance-score the twin against real API behavior with quantitative divergence reporting
- **Lua handlers**: fill gaps the synth engine can't infer (computed fields, state machines, cross-entity joins)
- **simulate**: fault injection, latency, and rate-limit layers turn your twin into a local chaos lab — deterministically, with a shared RNG seed
- **trace**: ring-buffered request/response log exposed via `/__wraith/trace/*` for post-test inspection
- **explore**: (optional) seed from OpenAPI — generate scenario plans and measure spec-vs-recording coverage
- **streaming**: SSE + gRPC server-streaming end-to-end — record long-lived streams live, synthesize per-event templates, serve realistic stream replay, conformance-check honestly. See [Streaming](https://wraith.cx/streaming/).

Current: 18 twins at PASS (REST, GraphQL, gRPC unary + server-streaming, SSE). See [CHANGELOG.md](./CHANGELOG.md).

## Quickstart

```bash
# Create a twin
wraith init myapi --base-url https://api.example.com

# Record real traffic via the proxy
wraith record myapi --port 8080 &
# … point your app at http://localhost:8080 and exercise the API …
curl http://localhost:8080/__wraith/new-session -XPOST  # close session
kill %1

# Synthesize the twin model
wraith synth myapi

# Verify conformance in-memory
wraith check myapi --in-memory

# Serve the twin
wraith serve myapi --port 8081
curl http://localhost:8081/...

# Or serve it as a realistic failing/slow/rate-limited service
wraith serve myapi --port 8081 \
  --chaos-seed 42 \
  --latency-mode percentile --latency-p50 80 --latency-p95 400 --latency-p99 1200 \
  --rate-limit \
  --trace
```

Full documentation at [wraith.cx](https://wraith.cx).

## License

wraith is distributed under the [Elastic License 2.0](./LICENSE). Free for evaluation, personal use, internal business use, and use in consulting engagements. Restricts redistribution, hosted-service offerings, and circumvention of licensing functionality.

## Support

Private beta - contact the maintainer directly.
