---
title: Twin Response Contract
description: How a running wraith twin dispatches routes and entities, what X-Wraith-* headers every response carries, and how fidelity modes interact. Applies to wraith 0.18.0+.
---

This page is the authoritative reference for how a running twin responds to requests. It covers route and entity dispatch, provenance headers, fidelity mode interactions, and the complete set of `X-Wraith-*` response headers an agent harness or test suite may observe.

Applies to **wraith 0.18.0 and later**. See [Migration notes](#migration-notes) if you are upgrading from an older synthesized model.

Cross-referenced from `wraith serve --help`.

---

## Hits and Misses

### Route-level dispatch

The twin maintains a route trie built from the synthesized model. Every incoming request is matched against it first.

| Situation | Status | Body | Provenance |
|-----------|--------|------|------------|
| Route **hit** — method + path matched a known template | varies | served response (see entity dispatch below) | `recorded`, `template`, `handler`, `fixture`, or `fault` |
| Route **miss** — no template matched | 501 | structured miss body (see below) | `template` |

**Structured 501 body (route miss):**

```json
{
  "error": "no matching route",
  "wraith": {
    "twin": "rec-catalog",
    "routes": ["GET /v3/assets", "GET /v3/assets/:param"],
    "hint": "route not in recorded coverage; see `wraith coverage`"
  }
}
```

- `wraith.twin` — the served twin name; `null` when not injected (in-process tests).
- `wraith.routes` — route templates in `METHOD /path/:param` form, capped at 20. When the twin has more routes, `wraith.routes_total` carries the full count.
- `wraith.hint` — points at `wraith coverage` for recorded-coverage analysis.
- The `error` field is preserved for backward compatibility.

---

### Entity-level dispatch (route hit)

After a route match, entity-bearing routes (path-parameterized GET/PUT/PATCH/DELETE) look up the requested entity id.

**Gate scope.** The fail-closed gate is applied before Read/List state-op rendering, so it fires on read routes and parameter-bearing list routes that carry **at least one path parameter** — the requested id is the route's **last** path-parameter value. This deliberately includes parameter-bearing *nested-collection* routes: `GET /orgs/:param/repos` gates on the parent `:param` (the org), so an unknown org returns a fail-closed miss rather than a synthesized repo collection. Only non-parameterized routes (`GET /orgs`) and non-Read/List routes are never gated.

**Multi-param identity.** On a re-synthed model the gate keys on the *full ordered path-param tuple* per route pattern, so a never-recorded `(parentB, lastId)` whose `lastId` was only recorded under a sibling `parentA` fails closed instead of fabricating a 200. Single-param routes are unaffected. **Legacy models** (synthesized before 0.18.0) carry no tuple index and fall back to the coarser last-param check — re-synth to pick up the stricter behavior.

**Known-ID set** (per session):

> IDs observed in recordings for that route's entity type  
> ∪ entities in `state/fixtures/` for the route's entity type  
> ∪ entities created through the twin's own state layer this session  
> (respects `X-Wraith-Session`; client-supplied ids on create are included)

| Situation | `synthesize` mode (default) | `not_found` mode (`--unknown-entity not_found`) |
|-----------|----------------------------|-------------------------------------------------|
| Entity id **in known-ID set** | 200 — served from state / recording / template | same |
| Entity id **not in known-ID set**, route has **no** 4xx variant | Synthesized 200, `provenance=template` (template-clone with the requested id inserted) | Fail-closed not-found (see preference order below) |
| Entity id **not in known-ID set**, route **has** a 4xx variant | 404/4xx — the recorded not-found variant | same |

**Fail-closed not-found preference order** (`not_found` mode):

1. The route's recorded or synthesized 4xx variant — the provider's own not-found shape (status 404 preferred; any 4xx accepted). Provenance stays `template`.
2. Else the structured 501 route-miss body (same shape as above) with status 501.

---

## Provenance Headers

Every application response carries provenance headers that describe how the response was produced. They are emitted by default and can be suppressed with `--no-provenance-headers` (or `[serve] provenance_headers = false` in `wraith.toml`).

### `X-Wraith-Provenance`

Single per-response value. One of:

| Value | Meaning |
|-------|---------|
| `recorded` | Verbatim recorded exchange — served by the exact-body short-circuit. |
| `template` | Synthesized from the model (template constants + holes, session state, error envelopes). The default when no more-specific branch fired. |
| `handler` | Produced by a Lua handler's successful return. |
| `fixture` | Served from a seeded fixture entity (`state/fixtures/`), including a read that overlays fixture-entity fields onto a template. |
| `fault` | A fault or rate-limit injection short-circuited normal serving before the body was rendered (fault Error/Throttle/Drop/Timeout and rate-limit 429). |

### `X-Wraith-Route`

Matched route template in wraith `:param` form, e.g. `GET /v3/assets/:id`. Present on every application response where a route matched. Absent on route-miss 501 responses (no template matched).

### `X-Wraith-Exchange`

Source exchange identity in `<session_id>/<index>` form. Present **only** when:

- `X-Wraith-Provenance: recorded`, AND
- The synthesized model was built with wraith 0.18.0 or later (models built before 0.18.0 omit this header — not an error, just re-synth to enable it).

Maps directly to the WREC file at `recordings/sessions/<session_id>/<index>.wrec.zst`.

### Opt-out

```sh
# CLI flag (takes precedence over wraith.toml)
wraith serve myapi --no-provenance-headers

# wraith.toml [serve] section
[serve]
provenance_headers = false
```

Suppresses `X-Wraith-Provenance`, `X-Wraith-Route`, and `X-Wraith-Exchange` together.

### `X-Wraith-Provenance-Counts` (debug only)

Enabled by `wraith serve --debug` (synth fidelity only). Carries coarse per-field origin counts for the response body:

```
X-Wraith-Provenance-Counts: recorded=12 template=4 fixture=0 handler=0
```

Vocabulary aligns with the per-response `X-Wraith-Provenance` wire words (`template` ≈ synthesized, `handler` ≈ authored/Lua) so a harness reads one vocabulary across both headers.

With `--debug` and `--trace` combined, each trace entry also carries the full per-field origin map — `GET /__wraith/trace/<id>` answers where every field of that response came from (template constant, echo, generated, state, fixture, or Lua handler).

---

## Fidelity Mode Interactions

`wraith serve --fidelity <strict|synth|permissive>` (or `[serve] fidelity` in `wraith.toml`). Default: `synth`.

| Mode | Route miss | Entity miss (unknown id) | Provenance values seen |
|------|-----------|--------------------------|------------------------|
| `synth` (default) | 501 structured miss | synthesized 200 (`template`) or fail-closed 404/501 (`not_found` mode) | all five |
| `strict` | 501 structured miss (no recordings match) | always fail-closed — strict mode never synthesizes, so an entity miss is inherently a not-found (recorded 4xx → synthesized 4xx → 501) | `recorded`, `fault` (no `template` for normal responses) |
| `permissive` | behaves like `synth` today | same as synth | same as synth |

:::note
`ServeFidelityMode` values are `strict | synth | permissive`. There is no `fuzzy` mode — that name appears in stale documentation.
:::

In **strict** mode the twin serves only verbatim recorded exchanges. A request that matches a route but has no exact recorded response gets the fail-closed treatment regardless of the `--unknown-entity` flag.

---

## All `X-Wraith-*` Response Headers

Every application response (all fidelity modes) may carry the following control headers. These are wraith control headers, not body PII — they are exempt from the outbound scrub pipeline.

| Header | Default | Description |
|--------|---------|-------------|
| `X-Wraith-Provenance` | ON | Per-response provenance word: `recorded \| template \| handler \| fixture \| fault`. Suppressed by `--no-provenance-headers`. |
| `X-Wraith-Route` | ON | Matched route template (`METHOD /path/:param`). Suppressed by `--no-provenance-headers`. |
| `X-Wraith-Exchange` | conditional | `<session_id>/<index>` source identity; present only for `recorded` responses on models synthesized with 0.18.0+. Suppressed by `--no-provenance-headers`. |
| `X-Wraith-Twin-Age` | always | Twin age in whole seconds at server startup (does not tick; divide by 86400 for days). Anchors on the newest recording session; model-only twins fall back to `synth_timestamp`. |
| `X-Wraith-Recorded-At` | when available | RFC 3339 UTC timestamp of the newest source recording. Omitted when the twin has no recordings on disk. |
| `X-Wraith-Provenance-Counts` | `--debug` only | Coarse per-field origin counts (see above). |

The same freshness fields (`twin_age_seconds`, `recorded_at`, `synthesized_at`, `drifted_routes`) appear in the `--ready-json` envelope and `GET /__wraith/info` so agents or CI can read freshness without parsing headers.

---

## Quick Reference for Agent Harnesses

```sh
# Start the twin and capture the serving URL
wraith serve myapi --port 0 --ready-json /tmp/ready.json &
URL=$(jq -r .serve.url /tmp/ready.json)

# Check a response's provenance
curl -s -D- "$URL/v1/items/42" | grep -i x-wraith

# X-Wraith-Provenance: recorded
# X-Wraith-Route: GET /v1/items/:id
# X-Wraith-Exchange: sess_abc123/7
# X-Wraith-Twin-Age: 86400
# X-Wraith-Recorded-At: 2026-06-01T12:00:00Z

# Route miss — 501 with structured body
curl -s "$URL/nonexistent" | jq .wraith.hint
# "route not in recorded coverage; see `wraith coverage`"

# Enable fail-closed entity semantics for agent sandboxes
wraith serve myapi --unknown-entity not_found

# Serve with strict replay (recorded responses only)
wraith serve myapi --fidelity strict
```

See also: `wraith inspect <twin> --provenance` for static per-route provenance without serving.

---

## Migration Notes

If you are upgrading a twin that was synthesized before wraith 0.18.0, run `wraith synth <twin>` after upgrading to pick up:

- **Known-ID tuple index** — the multi-param entity gate uses a full path-param tuple per route, not just the last param. Without re-synth, an entity id shared across different parent contexts passes the gate when it should not.
- **`X-Wraith-Exchange` header** — source exchange identity (`<session_id>/<index>`) is only emitted for models that carry the identity index from 0.18.0's synth pass. Without re-synth the header is simply absent; responses are otherwise unaffected.

Twins that do not use multi-param routes and do not need the Exchange header are unaffected and continue to serve correctly without re-synth.
