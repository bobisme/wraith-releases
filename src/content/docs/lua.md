---
title: Lua handlers for Wraith twins
description: "Write Lua handlers for routes whose behavior the synth engine can't infer algorithmically: computed totals, conditional response shapes, list aggregates, state machines, cross-entity joins. Covers the API, the filename convention, the sandbox, and a minimal handler."
---

Lua handlers are the escape hatch. When a route's behavior depends on input-dependent logic that anti-unification can't recover from observations alone — a checkout total computed from line items, a status machine where the next state depends on the previous one — write a small Lua handler and `wraith serve` invokes it instead of rendering from the template.

The OrderLedger fixture twin ships seven Lua handlers and is the reference for the patterns below.

## Where handlers live

```
twins/<name>/lua/
├── handlers/      # one file per handler, named to match a route convention
│   ├── create_order.lua
│   ├── get_order.lua
│   └── list_orders.lua
└── lib/           # shared modules importable via wraith.import()
    └── json.lua
```

Both directories are scanned at startup. Files with `.lua` or `.luau` extensions are loaded. Handlers are keyed by filename stem — `create_order.lua` becomes the handler named `create_order`.

You don't have to re-synth to add or update a handler. Restart `wraith serve` and the new file is picked up.

## Filename → route convention

When a route variant carries an explicit `lua_hook` field (rare; synth never sets this), that handler wins. Otherwise — the common case — handlers resolve by filename matching against the route's inferred state op and entity type.

For routes with a state op:

| State op | Filenames that match                                                                |
|----------|--------------------------------------------------------------------------------------|
| Create   | `create_<entity>`, `add_<entity>`, `new_<entity>`, `post_<entity>`                  |
| Read     | `get_<entity>`, `read_<entity>`, `show_<entity>`, `fetch_<entity>`                  |
| Update   | `update_<entity>`, `patch_<entity>`, `edit_<entity>`, `put_<entity>`                |
| Delete   | `delete_<entity>`, `remove_<entity>`, `destroy_<entity>`                            |
| List     | `list_<plural>`, `list_<singular>`, `index_<plural>`, or bare `<entity>` (collection name) |

For sub-resource routes (`GET /orders/:id/invoice`) the convention switches to HTTP method + last path segment:

| Method     | Filenames that match                                                  |
|------------|------------------------------------------------------------------------|
| GET        | `get_<seg>`, `show_<seg>`, `read_<seg>`, `fetch_<seg>`                |
| POST       | `create_<seg>`, `post_<seg>`, `add_<seg>`, `new_<seg>`                |
| PUT, PATCH | `update_<seg>`, `patch_<seg>`, `edit_<seg>`, `put_<seg>`              |
| DELETE     | `delete_<seg>`, `remove_<seg>`, `destroy_<seg>`                       |

First match wins. Routes that don't match any handler fall through to the synth template — silently, no warning. This is intentional: most routes don't need a handler.

### How `<entity>` and `<seg>` are derived

`<entity>` comes from the route's inferred entity type — the collection segment of the path (the segment before the id parameter, e.g. `customers` in `/v1/customers/:id`, or the last segment for a list route like `/v1/charges`). Version prefixes (`v1`, `v2`, …) are skipped.

The entity name is **singularized** for Create / Read / Update / Delete and offered in both singular and plural for List, so you don't have to guess the count:

- `POST /v1/customers` → `create_customer` (singular)
- `GET /v1/customers` → `list_customers` (plural), also `list_customer`, `customers`, `customer`

The name is also **normalized to `snake_case`** before matching, so handler files stay legal identifiers no matter how the API spells its paths. A hyphenated, dotted, or camelCase collection all bind to the same snake_case file:

| Route                               | Inferred entity     | Handler file (Read-by-id)        |
|-------------------------------------|---------------------|----------------------------------|
| `GET /v3/license-agreements/:id`    | `license-agreement` | `get_license_agreement.lua`      |
| `GET /v1/lineItems/:id`             | `lineItem`          | `get_line_item.lua`              |
| `GET /api/PaymentMethods/:id`       | `PaymentMethod`     | `get_payment_method.lua`         |
| `POST /orders/:id/line-items`       | sub-resource `line-items` | `create_line_item.lua`     |

Always name handler files in `snake_case` — `get_license_agreement.lua`, not `get_license-agreement.lua`. The raw on-the-wire spelling is also accepted as a fallback, but `snake_case` is the convention and the form shown by tooling.

### `lua_hook` and re-synth

The `lua_hook` field on a variant is an explicit, advanced override — it pins one variant to a named handler regardless of filename. **`wraith synth` never writes `lua_hook`, and re-synth rebuilds variants from recordings, so any hand-edited `lua_hook` is dropped on the next synth.** Don't rely on it for normal binding. The filename convention above is the supported, re-synth-safe mechanism: drop a correctly named file in `lua/handlers/` and it keeps binding across every re-synth, because the binding is derived from the route, not stored in the model.

## The API surface

Every handler sees four global tables.

### `req` — read-only request context

```lua
req.method     -- "POST"
req.path       -- "/v1/orders"
req.headers    -- table with lowercase keys
req.query      -- table of query string values
req.body       -- raw request body as a string (or nil)
```

### `emit` — write response

```lua
emit.status(201)
emit.header("content-type", "application/json")
emit.json(table)                  -- set body (JSON serializes from a Lua table)
emit.body(string_or_table)        -- alias for emit.json()
emit.error(400, "invalid", "...")  -- structured error envelope
```

### `state` — per-session state store

Backed by the same per-namespace state store the synth dispatcher uses, so handlers and template-rendered routes can share entities.

```lua
state.get(entity_type, id)                  -- → table | nil
state.put(entity_type, id, data)            -- upsert; returns true
state.delete(entity_type, id)               -- → true
state.list(entity_type)                     -- → table of all entities of that type
state.query(entity_type, field, value)      -- → array of entities where field == value
state.count(entity_type)                    -- → number
state.counter(name)                         -- atomic increment, returns new value
```

### `clock` — deterministic time

```lua
clock.now()        -- current Unix timestamp (seconds)
clock.advance(60)  -- advance the namespace clock; deterministic mode only
```

When `[serve.clock] mode = "real"` (the default), `clock.now()` reads the system clock. When `mode = "deterministic"`, it reads from the seeded counter — same seed produces byte-identical timestamps across runs. See [Configuration → `[serve.clock]`](/configuration/#serveclock).

## Importing libraries

Files under `lua/lib/` are loadable via `wraith.import`:

```lua
local json = wraith.import("json")
local body = json.decode(req.body)
```

Each `wraith.import` call runs the library in an isolated scope and returns its exported module table.

## A minimal handler

`twins/orderledger/lua/handlers/create_order.lua`, lightly edited:

```lua
-- POST /orders — create order with computed total.
local json = wraith.import("json")

local body = json.decode(req.body)
if not body or not body.customer_id then
  emit.status(400)
  emit.json({ error = { code = "invalid_request", message = "customer_id is required" } })
  return
end

-- Reference an existing entity.
local customer = state.get("customers", body.customer_id)
if not customer then
  emit.status(400)
  emit.json({ error = { code = "invalid_customer", customer_id = body.customer_id } })
  return
end

-- Compute the total from request items.
local items = body.items or {}
local total = 0
for _, item in ipairs(items) do
  total = total + (item.price or 0) * (item.qty or 1)
end
total = math.floor(total * 100 + 0.5) / 100   -- round to 2 decimals

-- Generate an ID via the namespace counter.
local seq = state.counter("order_seq")
local oid = string.format("ord_%08x", seq)
local now = clock.now()

local order = {
  id          = oid,
  customer_id = body.customer_id,
  items       = items,
  item_count  = #items,
  total       = total,
  status      = "draft",
  created_at  = now,
  updated_at  = now,
}

state.put("orders", oid, order)

emit.status(201)
emit.json(order)
```

Patterns this demonstrates:

- Parse the request body and validate.
- Reference an entity that was seeded (or created earlier in the session) via `state.get`.
- Generate a deterministic ID via the namespace counter.
- Read the deterministic clock for `created_at` / `updated_at`.
- Persist the new entity via `state.put`.
- Set status and body via `emit`.

## The sandbox

Handlers run in mlua's [Luau](https://luau-lang.org/) sandbox with `sandbox(true)` enabled. The following are NOT available:

- `io`, `os`, `debug` libraries (no filesystem, no system access, no introspection).
- `load`, `loadstring` (no dynamic compilation).
- `getmetatable`, `setmetatable`, `rawget`, `rawset` (no protocol escape).
- Network or FFI access.

What IS available:

- `math`, `string`, `table`, `type`, `ipairs`, `pairs`, `next`, `select`, `tonumber`, `tostring`.
- `error`, `pcall`, `xpcall` for controlled error handling.
- The four globals above (`req`, `emit`, `state`, `clock`).
- `wraith.import(name)` for loading shared libraries.

Per-invocation limits:

- **100 ms wall-clock timeout.** Long-running handlers get killed.
- **1 MB memory limit.**
- **100,000 Luau instructions.** CPU budget.

Exceeding any limit raises a handler error and falls into the configured `on_error` policy.

## Error handling

`[serve.lua] on_error` in `wraith.toml` controls what happens when a handler raises:

```toml
[serve.lua]
on_error = "fail"      # default
```

In `fail` mode, an uncaught handler error returns HTTP 500 with a structured envelope:

```json
{
  "error": {
    "type": "internal_error",
    "message": "Handler execution failed: ...",
    "handler": "create_order"
  }
}
```

In `fallback` mode (legacy), the error is logged and dispatch falls through to the synth template. This hides bugs and is opt-in only for compatibility with twins authored before `on_error` shipped.

## Your handler's output is checked

Since v0.17.0, `wraith check` compares your handler's raw output against the shape of the recorded responses for the route. A structural slip — a mis-cased field name, a missing key, a wrong type — fails the check with a named `authored_deviation` finding instead of shipping silently. Deviations you *mean* (serving an empty collection your workflow doesn't need, say) are declared in `wraith.toml`:

```toml
[[deviations]]
route = "GET /assets/:id"
path = "$.comparisonSegments"
reason = "segments unused in this workflow"
```

While migrating, `[handlers] deviation_policy = "warn"` reports without failing. Details in [Conformance & drift](/conformance/#authored-output-deviations-lua-handlers--fixtures). Provenance-wise, handler-served fields are classed `authored` in check's fiction-ratio report — a reviewer can see at a glance how much of a twin is hand-written vs recorded.

## When NOT to use Lua

- **Echo a field from the request into the response.** Synth's value-flow graph detects request echoes algorithmically — let it. Writing a Lua handler for this is more brittle than the inferred template.
- **Return a different shape based on a request field.** Use [request keying](/changelog/#v080) (`[generate.request_keying]`) — synth will synthesize one variant per bucket. Lua should be the second resort.
- **Generate a constant body that varies only by hole.** Synth's hole classifier already covers this.

Lua is for behavior synth can't infer: computed totals, multi-step state transitions, cross-entity joins, things where the response depends on a small program. If you're writing the same handler-shaped code in your test fixtures, that's a strong signal it belongs as a Lua handler in the twin instead.
