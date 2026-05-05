---
title: Simulate API failures locally with Wraith
description: "Turn your twin into a chaos lab: fault injection, latency, rate limiting, and trace endpoints"
---

A twin that always returns 200s at 0ms is a liar. Real APIs rate-limit, time out, return 500s under load, and take 300ms when they feel like it. `wraith serve` can simulate all of this - deterministically, per route, with a shared RNG seed so the same seed produces the same fault sequence every time.

There are three simulation layers plus a trace endpoint for observability:

```
incoming request
  -> rate-limit   (real-behaviour baseline from recordings or CLI overrides)
  -> fault        (injected faults from a profile or chaos seed)
  -> latency      (simulated response timing)
  -> dispatch     (normal twin response)
  -> trace        (optional ring buffer for inspection)
```

All four are opt-in. With no flags set, `wraith serve` has zero simulation overhead - no allocation, no locking, no wrapper calls.

## Fault injection

Six fault types, selected per rule:

| Type       | Behaviour                                                       |
|------------|-----------------------------------------------------------------|
| `error`    | Return a specific status + body                                 |
| `delay`    | Sleep `[min_ms, max_ms]` then serve the normal response         |
| `timeout`  | Sleep `hold_ms`, then return 504 (connection is not severed)    |
| `drop`     | Return 499 with `Connection: close` and an empty body           |
| `throttle` | Return 429 with `X-RateLimit-*` + `Retry-After` headers         |
| `partial`  | Run normal dispatch, then truncate the response body to N bytes |

### From a profile file

```sh
wraith serve myapi --fault-profile faults.toml
```

```toml
# faults.toml
name = "staging-chaos"

# 10% of all requests fail with 500
[[rules]]
route = "*"
percentage = 10
[rules.fault_type]
type = "error"
status = 500
body = '{"error":"simulated failure"}'

# 5% of writes slow to 500-1500ms
[[rules]]
route = "POST /v1/*"
percentage = 5
[rules.fault_type]
type = "delay"
min_ms = 500
max_ms = 1500

# Always throttle /v1/reports with 10 req/60s, but only for requests with a specific header
[[rules]]
route = "GET /v1/reports"
percentage = 100
header_match = ["X-Tenant", "demo"]
[rules.fault_type]
type = "throttle"
limit = 10
window_secs = 60

# First 3 calls to /v1/bootstrap fail with 503, then stop
[[rules]]
route = "POST /v1/bootstrap"
percentage = 100
count = 3
[rules.fault_type]
type = "error"
status = 503
body = '{"error":"service warming up"}'
```

Rules are evaluated in order; the first match wins. `route` supports `*` (match all) and prefix glob (`/v1/*`). `header_match` requires a case-insensitive key + exact value. `count` caps the total number of times a rule triggers; omit for unlimited.

### Or let wraith generate chaos

```sh
wraith serve myapi --chaos-seed 42
```

This calls `generate_chaos_profile(seed, routes)` against the loaded WIR and produces a deterministic mix: ~30% of routes get a random error at 5-15%, ~25% get a delay at 10-30%, ~15% get throttling, ~5% get timeouts. Same seed + same twin = same profile, every time.

### Determinism

The fault layer uses a seeded `ChaCha8Rng` for the percentage rolls and delay bounds. To reproduce a failure sequence:

```sh
wraith serve myapi --fault-profile faults.toml --fault-seed 17
```

Every request (in order) against the same twin will roll identically.

## Latency simulation

Six modes, picked with `--latency-mode`:

| Mode         | Flags                                                      |
|--------------|------------------------------------------------------------|
| `none`       | (default - no latency added)                              |
| `fixed`      | `--latency-ms <ms>`                                        |
| `uniform`    | `--latency-min-ms <ms> --latency-max-ms <ms>`              |
| `percentile` | `--latency-p50 <ms> --latency-p95 <ms> --latency-p99 <ms>` |
| `recorded`   | `--latency-config <path>` (reads arrays from TOML)         |
| `normal`     | `--latency-config <path>` (mean + stddev from TOML)        |

The `recorded` and `normal` modes need a config file because their inputs don't fit cleanly on the command line:

```toml
# latency-config.toml
[default]
mode = "normal"
mean_ms = 120
stddev_ms = 40

# Override per route
[[routes]]
route = "GET /v1/customers/:id"
mode = "fixed"
ms = 30

[[routes]]
route = "GET /v1/reports/*"
mode = "recorded"
latencies = [180, 220, 340, 410, 280, 190, 510]
```

### Determinism

```sh
wraith serve myapi --latency-mode uniform --latency-min-ms 50 --latency-max-ms 200 --latency-seed 7
```

Same seed + same request sequence produces the same latency vector (within OS scheduling noise).

### Interaction with fault injection

If a fault rule triggers `Delay{ms}` for a request, that delay **replaces** the latency simulator's contribution for that request. No compounding, no double-sleep.

## Rate limiting

Two modes of rate limiting that share the same engine and response shape:

### WIR-stored limits

Your recorded API may have rate limits in its responses. Once synth-side detection lands (planned for a future release), those limits will be populated into the twin's WIR automatically. For now, you can pre-populate `rate_limit` on routes manually or use CLI overrides:

```sh
wraith serve myapi --rate-limit
```

### CLI overrides

```sh
wraith serve myapi \
  --rate-limit \
  --rate-limit-override "GET /v1/users=100/60" \
  --rate-limit-override "POST /v1/charges=10/60"
```

The `"METHOD /path=N/Wsec"` syntax sets a limit of N requests per W seconds for that route. Overrides add to or replace WIR entries.

### Response shape

When the limit is exceeded:

```
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1729627200
Retry-After: 42
Content-Type: application/json

{"error":"rate limited"}
```

The exact same response shape is produced by `fault_type = "throttle"` - they share a single builder (`runtime/http_util.rs`).

### Algorithms

- **FixedWindow** (default): counter resets at window boundaries. Simple, bursty.
- **SlidingWindow**: tracks request timestamps and returns 429 as soon as the recent-window count exceeds the limit. Smoother, slightly more expensive.

Select via the WIR entry or the override config.

## Trace endpoints

When you want to see exactly what the twin served during a test run:

```sh
wraith serve myapi --trace --trace-capacity 5000
```

Three endpoints are then mounted on the twin:

```
GET  /__wraith/trace/log         # reverse-chronological ring buffer as JSON
GET  /__wraith/trace/<id>        # single trace by id
POST /__wraith/trace/reset       # clear the buffer
```

Each trace records method, path + query, status, duration (us), timestamp, and session id (from `x-wraith-session` header, falling back to `"default"`). Capacity bounds the ring; older entries are evicted FIFO.

Trace endpoints are gated by the same auth policy as the rest of `/__wraith/*` when you bind to a non-loopback interface (see [Configuration](/configuration/#hmac-key-management)). They are **off by default** - no overhead when `--trace` is absent.

## Putting it together

A realistic "staging API" twin that fails like a real one:

```sh
wraith serve myapi \
  --port 8081 \
  --rate-limit \
  --rate-limit-override "POST /v1/charges=5/60" \
  --fault-profile ./staging-faults.toml \
  --fault-seed 1 \
  --latency-mode percentile \
  --latency-p50 80 --latency-p95 400 --latency-p99 1200 \
  --latency-seed 1 \
  --trace --trace-capacity 10000
```

Now your integration tests hit an API that:
- Rate-limits bursts on `POST /v1/charges`
- Injects the specific failure pattern from `staging-faults.toml`
- Responds with realistic p50/p95/p99 latency
- Records every request for post-test inspection
- Is bit-reproducible given the seeds

That's what you want your test suite to have been hitting all along.
