---
title: Wraith API twin lifecycle
description: "Learn the full recorded-traffic API mocking workflow: record, synthesize, verify conformance, repair drift, and serve a local twin."
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "Wraith API twin lifecycle",
  "description": "Record, synthesize, verify, repair, and serve a local API twin with Wraith.",
  "step": [
    {"@type": "HowToStep", "name": "Record", "text": "Capture real API exchanges through the local Wraith proxy."},
    {"@type": "HowToStep", "name": "Synthesize", "text": "Build a deterministic model from all recorded sessions."},
    {"@type": "HowToStep", "name": "Check conformance", "text": "Replay recorded exchanges through the synthesized model and inspect divergences."},
    {"@type": "HowToStep", "name": "Repair", "text": "Use generated fixes or Lua handlers for routes the engine cannot infer."},
    {"@type": "HowToStep", "name": "Serve", "text": "Run the local twin and point tests, demos, or agents at it."}
  ]
}
</script>

This guide covers the full workflow for building and maintaining an API twin, from first recording to production-quality service.

## Overview

```
record → synth → check → generate → check → [lua handlers] → serve
  ↑                                    ↓
  └────────── re-record if needed ─────┘
```

1. **Record** real API traffic
2. **Synthesize** a deterministic model from recordings
3. **Check** conformance (how well the model matches recordings)
4. **Generate** LLM-assisted fixes for remaining divergences
5. **Lua handlers** for routes the engine can't fix algorithmically
6. **Serve** the twin to your test suite

## 1. Record

Capture real API exchanges by proxying traffic through wraith:

```sh
wraith init stripe --base-url https://api.stripe.com
wraith record stripe --port 8080
```

Point your app at `http://localhost:8080` and exercise the API. Each request/response pair is saved as a WREC file with secrets scrubbed.

### Multiple sessions

Record multiple sessions to give the synthesizer enough variation. Use `/__wraith/new-session` to force a session boundary without restarting the proxy:

```sh
wraith record stripe --port 8080 &

# Session 1: basic CRUD
python exercise.py --base-url http://localhost:8080 --sessions 10
curl -X POST http://localhost:8080/__wraith/new-session

# Session 2: edge cases, errors
python exercise.py --base-url http://localhost:8080 --sessions 10 --errors
curl -X POST http://localhost:8080/__wraith/new-session

# Session 3: different data patterns
python exercise.py --base-url http://localhost:8080 --sessions 10 --varied

kill %1
```

The `new-session` endpoint closes all active sessions and finalizes their manifests. Subsequent exchanges start fresh sessions automatically.

### Recording control plane

During recording, the proxy exposes control endpoints at `/__wraith/*`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/__wraith/health` | GET | Returns `{"status": "recording"}` |
| `/__wraith/ready` | GET | Returns `{"ready": true}` |
| `/__wraith/info` | GET | Active sessions, upstream URL, port |
| `/__wraith/new-session` | POST | Force session boundary |

These are intercepted before proxying - they never reach the upstream API.

### Session tagging

Tag sessions for selective synthesis:

```sh
wraith record myapi --tag ci-test &
python exercise-ci.py --base-url http://localhost:8080
kill %1

# Later: build a model from only ci-test sessions
wraith synth myapi --tag ci-test
```

## 2. Synthesize

Build a deterministic model from all recorded sessions:

```sh
wraith synth stripe
```

This produces `twins/stripe/model/symbols.json` - the WIR (Wraith Intermediate Representation) containing:
- Route patterns with parameterized paths
- Response templates with typed holes (dynamic fields)
- Variants per status code (200, 404, etc.)
- State operations (CRUD mapping)
- Field classifications (constant, generated, timestamp, echo)
- GraphQL operation routing (if detected)

```
synth  stripe  25 routes  3544 symbols  22 state-ops
```

### GraphQL

wraith detects GraphQL endpoints automatically (`POST /graphql` with `query` field). It splits the single route into per-operation variants using `operationName` or parsed query root field:

```
detected GraphQL endpoint - splitting by operation  route=POST /graphql  exchanges=257
GraphQL operation groups: AddComment, CloseIssue, CreateIssue, ...  operations=16
```

No configuration needed. Named queries, anonymous queries, mutations, and fragments all work.

## 3. Check conformance

Measure how well the synthesized model matches the recordings:

```sh
wraith check stripe --in-memory
```

```
PASS  stripe  10000/10000  sessions=3/3  divergences=0
```

The score is in basis points (10000 = perfect). Divergences show where the model differs from recordings:
- `missing_field` - recording has a field the model doesn't produce
- `extra_field` - model produces a field the recording doesn't have
- `value_mismatch` - field exists but value differs
- `status_mismatch` - HTTP status code differs
- `type_mismatch` - response body type differs

### Understanding suppressions

The engine auto-suppresses comparison for fields it can't reproduce deterministically (generated IDs, timestamps, list contents). Use `--show-suppressed` to see what's being hidden:

```sh
wraith check stripe --in-memory --show-suppressed
```

```
PASS  stripe  10000/10000  sessions=3/3  divergences=0 (264 suppressed)
  Suppressed fields:
    body.id                                            generated
    body.created                                       timestamp
    body.updated                                       timestamp
    body.data[*].id                                    generated
    headers.x-request-id                               header_allowlist
    ...

  To compare a suppressed field, add to wraith.toml:
    [diff.fields."<path>"]
    classify = "constant"
```

Suppression reasons:
- **generated** - dynamic field (IDs, random values), compared by type only
- **timestamp** - time-like field, compared by type only
- **header_allowlist** - header not in the 3-header comparison list
- **heuristic** - field name pattern (`*_at`, `*_count`) with matching types

### Forcing comparison

If a suppressed field matters to you, force comparison in `wraith.toml`:

```toml
[diff.fields]
# These fields are computed - compare exactly, don't suppress
"total" = { classify = "constant" }
"summary.total_value" = { classify = "constant" }
"customer_name" = { classify = "constant" }
```

Valid classifications: `"generated"`, `"timestamp"`, `"constant"`, `"echoed"`, `"enum"` (use with a `values` list).

## 4. Generate (LLM-assisted repair)

Use the agentic route fixer to automatically fix divergences:

```sh
wraith generate stripe --provider ollama --model qwen3.5:9b
```

The generator:
1. Picks the route with the most divergences
2. Gives the LLM tools to inspect and edit the model
3. Runs conformance checks after each edit
4. Accepts improvements, rolls back regressions
5. Repeats for the next route

Options:

```sh
wraith generate stripe --agentic             # force agentic (tool-use) mode
wraith generate stripe --max-iterations 10   # fix up to 10 routes
wraith generate stripe --provider openrouter --model anthropic/claude-sonnet  # cloud model
```

The regression guard ensures no fix makes things worse - both per-route and globally.

## 5. Lua handlers

Lua handlers are a first-class extension point for responses the deterministic
engine can't express. Drop into Lua when you need:

- **Computed fields**: totals, averages, aggregates derived from state
- **Conditional shapes**: fields present only under certain conditions
- **Cross-entity joins**: response includes data from a related entity
- **State machine validation**: only certain transitions are valid
- **Custom formatting**: non-standard date formats, encoded cursors

If a Lua handler fails (compile error, runtime error, timeout), the synth engine
takes over as fallback. Lua never breaks the twin, so it's safe to layer on
incrementally.

### Directory layout

```
twins/myapi/lua/
├── handlers/        # Handler scripts (one per route)
│   ├── create_order.lua
│   ├── list_orders.lua
│   └── get_invoice.lua
└── lib/             # Shared libraries
    └── json.lua     # JSON parser (or any shared utility)
```

### Writing a handler

```lua
-- twins/myapi/lua/handlers/create_order.lua
-- Handles POST /orders - computes total from line items

local json = wraith.import("json")
local body = json.decode(req.body)

-- Compute total from items
local items = body.items or {}
local total = 0
for _, item in ipairs(items) do
    total = total + (item.price or 0) * (item.qty or 1)
end
total = math.floor(total * 100 + 0.5) / 100

-- Generate ID and store
local seq = state.counter("order_seq")
local oid = "ord_" .. string.format("%08x", seq)
local now = clock.now()

local order = {
    id = oid,
    customer_id = body.customer_id,
    items = items,
    item_count = #items,
    total = total,
    status = "draft",
    created_at = now,
    updated_at = now,
}
state.put("orders", oid, order)

emit.status(201)
emit.json(order)
```

### Available APIs

**Request context** (read-only):
```lua
req.method       - "GET", "POST", etc.
req.path         - "/orders/ord_123"
req.headers      - {["content-type"] = "application/json", ...}
req.query        - {["limit"] = "10", ...}
req.body         - request body string, or nil
```

**State store** (persistent across requests within a session):
```lua
state.get(type, id)           - read entity, returns table or nil
state.put(type, id, data)     - create or update entity
state.delete(type, id)        - delete entity
state.list(type)              - all entities of type
state.query(type, field, val) - filter by field equality
state.count(type)             - count entities
state.counter(name)           - atomic increment, returns new value
```

**Deterministic clock**:
```lua
clock.now()          - Unix timestamp (deterministic per session)
clock.advance(secs)  - advance clock (default: 1 second)
```

**Response builder**:
```lua
emit.status(201)                           - HTTP status code
emit.header("x-custom", "value")           - add response header
emit.json({id = "123", name = "test"})     - JSON body (from table)
emit.body('{"raw": "json string"}')        - raw body string
emit.error(404, "not_found", "message")    - shorthand error response
```

**Module system**:
```lua
local json = wraith.import("json")    - load lua/lib/json.lua
local utils = wraith.import("utils")  - load lua/lib/utils.lua
```

### Connecting handlers to routes

Set `lua_hook` on the variant in `symbols.json`:

```json
{
  "method": "POST",
  "path_pattern": "/orders",
  "state_op": "create",
  "variants": [{
    "status": 201,
    "body_template": {"id": "$hole_1", "total": "$hole_2", "...": "..."},
    "lua_hook": "create_order"
  }]
}
```

The handler name matches the filename without extension: `create_order` -> `handlers/create_order.lua`.

If the Lua handler succeeds, its response is used directly. If it fails (error, timeout, missing file), the synth engine takes over as fallback - Lua never breaks the twin.

### Resource limits

Handlers run in a sandboxed Luau VM:
- **Timeout**: 100ms wall-clock
- **Memory**: 1MB per invocation
- **Instructions**: 100,000 VM instructions
- No filesystem, network, or `os` access

### Validation

```sh
wraith doctor myapi
```

```
lua_handlers_valid  INFO  7 Lua handler(s) compiled successfully
```

### Example: computed fields vs synth engine

Without Lua, the synth engine classifies computed fields as Generated and skips comparison:

```
wraith check orderledger --in-memory
PASS  orderledger  10000/10000  sessions=2/2  divergences=185
  body.total  value_mismatch  expected=134.34  actual=0
  body.total  value_mismatch  expected=261.95  actual=0
  body.customer_name  value_mismatch  expected="Alice"  actual="Test 16"
  ...
```

With Lua handlers computing the values correctly:

```
wraith check orderledger --in-memory
PASS  orderledger  10000/10000  sessions=2/2  divergences=2
```

The remaining 2 are a floating-point rounding edge case. The Lua handlers reduced divergences from 185 to 2 by computing totals, aggregates, and cross-entity joins that the deterministic engine can't express.

## 6. Serve

Start the twin server:

```sh
wraith serve stripe
```

```
loaded Lua handlers  count=3
wraith server started  twin=stripe  addr=127.0.0.1:8081  fidelity=synth
```

Point your test suite at `http://localhost:8081`. The server:
- Matches requests to routes via the path trie
- Selects the matching variant based on guards
- Runs Lua handler if `lua_hook` is set on the variant
- Otherwise renders from the synth template with hole replacement
- Manages per-session state (entities, counters, clock)

### Fidelity modes

| Mode | Description |
|------|-------------|
| `strict` | Replay recorded responses verbatim (exact match) |
| `synth` | Serve from synthesized model with state engine + Lua handlers (default) |

## Iterating

The twin improves through iteration:

```
record more sessions → re-synth → check → generate → lua → check
```

Each cycle:
- More recordings give the synthesizer more variation to learn from
- Re-running `wraith synth` rebuilds the model from scratch
- `wraith generate` fixes remaining divergences with LLM assistance
- Lua handlers fill gaps the engine can't close
- `--show-suppressed` shows what the engine is hiding so you know where Lua is needed

Track progress with `wraith check --in-memory` - the session pass rate is the key metric.

## Deciding between engine, generate, and Lua

| Pattern | Who handles it | Example |
|---------|---------------|---------|
| CRUD responses with generated IDs | Synth engine | `POST /users` returns `{id: "uuid", ...}` |
| Timestamps, counters | Synth engine | `created_at`, `request_count` |
| Echoed request fields | Synth engine | Response contains request body values |
| Error variants by status | Synth engine | 400, 404, 422 responses |
| Template inconsistencies | Generate (LLM) | Wrong hole classification, missing optional field |
| Computed totals/aggregates | **Lua** | `total = sum(items[].price * qty)` |
| Conditional response shapes | **Lua** | `shipping` object only when status=shipped |
| Cross-entity joins | **Lua** | Invoice includes customer name from separate entity |
| State machine validation | **Lua** | Only `draft->confirmed->shipped->delivered` allowed |
| Non-JSON responses (HTML, binary) | **Lua** | Keycloak welcome page, binary downloads |
