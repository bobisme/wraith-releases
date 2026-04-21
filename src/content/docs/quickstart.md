---
title: Quickstart
description: Get a twin running in 5 minutes
---

Record real API traffic, synthesize a deterministic local twin, and verify conformance. No spec required. No vendor cooperation needed.

## Prerequisites

- A wraith binary on your `PATH` — see [Installation](/installation/)
- Access to the API you want to twin

## The full loop in 5 commands

```sh
wraith init github-actions --base-url https://api.github.com
wraith record github-actions --port 8080    # proxy traffic through wraith
# ... exercise the API endpoints ...
wraith synth github-actions                 # build the twin model
wraith check github-actions --in-memory     # verify conformance
wraith serve github-actions --port 8081     # serve the twin
```

Your tests now hit the twin instead of the real API: local, deterministic, millisecond responses.

## Step by step

### 1. Initialize a twin

```sh
wraith init myapi --base-url https://api.example.com
```

Creates `twins/myapi/` with configuration files:

```
twins/myapi/
├── wraith.toml          # Twin config (base URL, proxy, serve options)
├── scrub.toml           # Security scrubbing rules
├── recordings/sessions/ # Raw API recordings (WREC format)
├── model/               # Synthesized twin model
├── state/               # Runtime state and schema
└── reports/             # Conformance reports
```

### 2. Record API traffic

```sh
wraith record myapi --port 8080
```

This starts a reverse proxy. Point your application (or exercise script) at `http://localhost:8080` instead of the real API:

```
[your app] → [wraith :8080] → [api.example.com]
                ↓ (scrubbed)
           [WREC files on disk]
```

Secrets are scrubbed through a 3-layer pipeline **before** anything hits disk. Press Ctrl-C to stop recording.

For HTTPS upstream APIs (GitHub, Stripe, Cloudflare, etc.), wraith handles TLS automatically -- your app sends plain HTTP to the proxy.

**Tip:** Run your exercise multiple times with different data to get diverse recordings. More observations = better model.

```sh
# Record multiple sessions -- use /__wraith/new-session to force boundaries
wraith record myapi --port 8080 &
python exercise-myapi.py --base-url http://localhost:8080 --sessions 20
curl -X POST http://localhost:8080/__wraith/new-session    # close current session
python exercise-myapi.py --base-url http://localhost:8080 --sessions 10
kill %1
```

Options:
```sh
wraith record myapi --port 9090              # custom port
wraith record myapi --tag smoke-test         # label the session
```

### 3. Synthesize the twin model

```sh
wraith synth myapi
```

This analyzes all recordings and builds a model:
- **Anti-unification**: finds the common template across response bodies, identifying which fields are constant, which vary, and how
- **Hole classification**: determines how each variable field is sourced (echoed from request, generated ID, timestamp, counter, etc.)
- **State inference**: detects CRUD operations and entity types
- **Route normalization**: parameterizes dynamic path segments (IDs, slugs)

Output: `twins/myapi/model/symbols.json` -- the model the twin serves from.

```
synth  myapi  25 routes  2146 symbols  22 state-ops
```

### 4. Verify conformance

```sh
wraith check myapi --in-memory
```

Replays every recorded exchange through the synthesized model and compares responses using semantic diff. Reports divergences by category:

```
[PASS] myapi: 4/4 sessions passed (100%)
  Divergences: 3
    extra_field: 2 (warning)
    type_mismatch: 1 (warning)
```

The `--in-memory` flag runs the check without starting an HTTP server -- faster and simpler.

To see what the engine is suppressing (generated IDs, timestamps, list contents):

```sh
wraith check myapi --in-memory --show-suppressed
```

For JSON output:

```sh
wraith check myapi --in-memory --format json
```

Exit code 0 = pass, exit code 2 = conformance threshold not met.

### 5. Serve the twin

```sh
wraith serve myapi --port 8081
```

Your twin is now an HTTP server. Point your test suite at `http://localhost:8081` instead of the real API. (Use a different port from the recording proxy so the two can coexist.)

The twin:
- Serves JSON responses matching the real API's structure
- Maintains CRUD state (create an entity, read it back, update, delete)
- Renders dynamic fields (timestamps, IDs, echoed values) correctly
- Returns appropriate error responses for unmodeled paths

```sh
# Your tests now run against the twin
curl http://localhost:8081/v1/customers
curl -X POST http://localhost:8081/v1/customers -d '{"name": "Test"}'
```

## Fidelity modes

| Mode     | Command | Description |
|----------|---------|-------------|
| `strict` | `wraith serve myapi --fidelity strict` | Replay recorded responses verbatim (exact match) |
| `synth`  | `wraith serve myapi` (default) | Serve from synthesized model with state engine |

Use `strict` when you need exact byte-for-byte responses. Use `synth` (default) for stateful CRUD behavior with generated IDs and timestamps.

## Working with cloud APIs

For APIs that require authentication (GitHub, Stripe, Cloudflare, etc.):

1. Set your API key in the environment
2. Your exercise script passes auth headers through the proxy
3. Wraith forwards them to the real API during recording (and scrubs them before writing to disk)
4. The twin does not validate auth headers when serving — it's local

```sh
export GITHUB_TOKEN=ghp_xxx
wraith init github --base-url https://api.github.com
wraith record github --port 8080 &
curl http://localhost:8080/user -H "Authorization: token $GITHUB_TOKEN"
kill %1
wraith synth github
wraith serve github --port 8081
# The twin does not check auth — any request that matches a route gets the stored response
curl http://localhost:8081/user
```

If your tests rely on getting `401` for a bad token, model that explicitly — either record the 401 exchange so it becomes a variant, or write a small Lua handler.

## Exercise scripts

For best results, write a Python script that exercises the API endpoints you need:

```python
#!/usr/bin/env python3
"""Exercise script for myapi."""
import json, os, random, urllib.request

BASE = "http://localhost:8080"
TOKEN = os.environ["MYAPI_TOKEN"]

def post(path, body):
    req = urllib.request.Request(
        f"{BASE}{path}",
        json.dumps(body).encode(),
        {"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"},
    )
    with urllib.request.urlopen(req) as resp:
        return resp.status, json.loads(resp.read())

# Create varied data across multiple runs
for i in range(10):
    post("/v1/customers", {"name": f"Customer {i}", "email": f"c{i}@test.com"})
    post("/v1/orders", {"customer_id": i, "amount": random.randint(100, 10000)})
```

Key principles:
- **Vary the data**: random names, different field combinations, optional fields sometimes included
- **Exercise error paths**: 404s, missing required fields, auth failures
- **Multiple runs**: more observations = tighter model
- **Cleanup**: delete test data after each run

See `scripts/exercise-*.py` in the repository for examples across 15 real APIs (REST + GraphQL).

## Session tagging

Tag recording sessions for selective synthesis:

```sh
# Record different scenarios separately
wraith record myapi --port 8080 --tag ci-test &
python exercise-ci.py --base-url http://localhost:8080
kill %1

wraith record myapi --port 8080 --tag exploratory &
python exercise-explore.py --base-url http://localhost:8080
kill %1

# Synthesize only from ci-test sessions
wraith synth myapi --tag ci-test
```

This keeps exploratory API calls out of your twin model.

## Reducing the corpus

If your recording corpus grows large or contains sessions you no longer need, `wraith reduce` trims it while preserving coverage:

```sh
wraith reduce myapi --target-size 50% --dry-run   # preview what would be removed
wraith reduce myapi --target-size 50%              # keep 50%, move the rest
wraith reduce myapi --target-size 20 --strategy diversity  # keep 20 most diverse sessions
```

Strategies: `coverage` (default -- fewest sessions covering all routes), `diversity` (maximize response shape variety), `recency` (keep newest). Removed sessions are moved, not deleted.

## Accepting known divergences

Some divergences are expected (placeholder timestamps, generated IDs). Suppress them in `wraith.toml`:

```toml
[[diff.suppress]]
path = "body.created_at"
reason = "twin uses placeholder timestamps"

[[diff.suppress]]
route = "POST /repos/*/statuses/*"
category = "value_mismatch"
reason = "commit status fields are state-dependent"
```

Suppressed divergences are excluded from reports and scoring. Supports `*` wildcards in route and path patterns.

## Per-twin configuration

Edit `twins/myapi/wraith.toml` to customize behavior:

```toml
[diff]
# Enable variant routing for APIs with heterogeneous endpoints
split_variants = true
```

See [Configuration Reference](/configuration/) for all options.

## Health checks

```sh
wraith doctor myapi
```

Verifies configuration, scrub rules, HMAC key, and recording integrity.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | User or configuration error |
| 2 | Conformance threshold not met |
| 3 | Security policy violation |
| 4 | Runtime error |

## Output formats

Every command supports `--format pretty` (default TTY), `--format text` (pipes), `--format json` (machine-readable), or `--json` shorthand.

## Next steps

- [Twin Lifecycle](/twin-lifecycle/) -- full record -> synth -> check -> serve workflow with Lua handlers
- [Configuration Reference](/configuration/) -- all `wraith.toml` and `scrub.toml` fields
- `wraith <command> --help` -- detailed help with examples for every command
