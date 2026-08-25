---
title: Twin Response Contract
description: How a running wraith twin dispatches routes and entities, what X-Wraith-* headers every response carries, and how fidelity modes interact. Applies to wraith 0.18.3+.
---

# Twin Response Contract

This page is the authoritative reference for how a running twin responds to
requests. It covers route and entity dispatch, provenance headers, fidelity
mode interactions, and the complete set of `X-Wraith-*` response headers an
agent harness may observe.

Cross-referenced from `wraith serve --help`.

For a task-oriented setup guide that combines these headers with per-agent
sessions, fixture provisioning, deterministic clocks, and reset semantics, see
[Sandboxing Agents With Wraith](sandboxing-agents.md).

---

## Hits and Misses

### Route-level dispatch

The twin maintains a route trie built from the synthesized model. Every
incoming request is matched against it first.

| Situation | Status | Body | Provenance |
|-----------|--------|------|------------|
| Route **hit** — method + path matched a known template | varies | served response (see entity dispatch below) | `recorded`, `template`, `handler`, `fixture`, `fault`, or `miss` |
| Route **miss** — no template matched | 501 | structured miss body (see below) | `miss` |

**Structured 501 body** (route miss):

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

- `wraith.twin` — the served twin name; `null` when not injected (in-process
  tests).
- `wraith.routes` — route templates in `METHOD /path/:param` form, capped at
  20. When the twin has more routes, `wraith.routes_total` carries the full
  count.
- `wraith.hint` — points at `wraith coverage` for recorded-coverage analysis.
- The `error` field is preserved for backward compatibility.

---

### Entity-level dispatch (route hit)

After a route match, entity-bearing routes (path-parameterized
GET/PUT/PATCH/DELETE) look up the requested entity id.

**Gate scope.** The fail-closed gate is applied before Read/List state-op
rendering, so it fires on `state_op = read` routes and parameter-bearing
`state_op = list` routes that carry **at least one path parameter** — the
requested id is the route's **last** path-parameter value. This deliberately
includes parameter-bearing *list / nested-collection* routes:
`GET /orgs/:param/repos` gates on the parent `:param` (the org), so an unknown
org returns a fail-closed miss rather than a synthesized repo collection. Only
non-parameterized routes (`GET /orgs`) and non-Read/List routes are never
gated. (This is a blessed refinement of the earlier "list routes unaffected"
wording: an unknown *parent* should not fabricate a child collection.)

**Relationship to the `state_member` discriminator.** When synth
observed both a 2xx and a 4xx variant on a Read route, it attaches a
`state_member` guard so the route *already* returns its 4xx for an
unknown/unseeded id in **both** modes. On the current corpus every Read route
that has a 4xx variant is `state_member`-guarded, so the `--unknown-entity`
flag changes no observable behavior there — it is defense-in-depth that
coincides with the guard. The flag's behavior-*changing* value shows on Read
routes that have **no** 4xx variant: default mode synthesizes a 200 for the
unknown id, `not_found` mode returns the structured 501 miss (tier 3 below).

**Multi-param identity.** On a **re-synthed** model the gate keys on
the *full ordered path-param tuple* per route pattern (`known_param_tuples`),
so a never-recorded `(parentB, lastId)` whose `lastId` was only recorded under
a sibling `parentA` now fails closed instead of fabricating a 200. Single-param
routes are unaffected: the tuple degenerates to the last param, so they keep
the last-param `known_ids` index (unioned per `entity_type` across routes) and
their behavior is byte-identical. **Legacy models** written before multi-param identity landed
carry no `known_param_tuples` field; they load and serve unchanged, falling
back to the coarser last-param check — a `(parentB, lastId)` still wrongly
passes until the twin is re-synthed. (On routes that also carry a 4xx variant
the `state_member` guard masks this regardless; the reachable gap was
multi-param routes *without* a 4xx variant.)

**Known-ID set** (per session):

> IDs observed **with any non-4xx outcome** in recordings for that route's
> entity type
> ∪ entities in `state/fixtures/` for the route's entity type
> ∪ entities created through the twin's own state layer this session
> (respects `X-Wraith-Session`; client-supplied ids are included)

**Known-MISSING set**: IDs whose *only* recorded outcome was a 4xx
— direct recorded not-found evidence (e.g. a zero-uuid probe deliberately
recorded receiving a 404). This is the disjoint complement of the known-ID set:
an id that got a 2xx even once is "known", never "missing". In `not_found` mode
the gate consults known-MISSING **before** known, so an id the twin holds
recorded not-found evidence for fails closed instead of fabricating a 200
(which the old harvest-every-id-regardless-of-status behavior did). Both sets
are consulted only in `not_found` mode; default `synthesize` mode reads
neither, so its behavior is unchanged.

| Situation | `synthesize` mode (default) | `not_found` mode (`--unknown-entity not_found`) |
|-----------|----------------------------|-------------------------------------------------|
| Entity id **in known-ID set** | 200 — served from state / recording / template | same |
| Entity id **in known-MISSING set** (recorded 4xx-only) | Synthesized 200, `provenance=template` (default mode is unchanged) | Fail-closed not-found, `provenance=miss` (see preference order below) |
| Entity id **not in known-ID set**, route has **no** 4xx variant | Synthesized 200, `provenance=template` (template-clone with the requested id inserted) | Fail-closed not-found (see preference order below) |
| Entity id **not in known-ID set**, route **has** a 4xx variant | Already 404/4xx via the `state_member` guard (the id isn't a state member) | Same 4xx — the gate and the guard select the same variant |

> **Exact-replay first.** In both modes the exact-body short-circuit runs
> before this gate, so a request for the *exact recorded URL* of a 4xx-only id
> replays that recorded 404 verbatim with `provenance=recorded`. The
> known-MISSING gate only engages when exact replay is defeated — e.g. an added
> query param, or a re-synthed model without raw bodies.

**Fail-closed not-found preference order** (`not_found` mode):

1. The route's recorded or synthesized 4xx variant — the provider's own
   not-found shape (status 404 preferred; any 4xx accepted). Provenance is
   `miss`: a policy-produced coverage decision, not a verbatim
   recorded 404.
2. Else the structured 501 route-miss body (same shape as above, reused as
   tier-3 fallback) with status 501, also `provenance=miss`.

---

## Provenance Headers

Every application response carries provenance headers that describe how the
response was produced. They are emitted by default and can be suppressed with
`--no-provenance-headers` (or `[serve] provenance_headers = false` in
`wraith.toml`).

### `X-Wraith-Provenance`

Single per-response value. One of:

| Value | Meaning |
|-------|---------|
| `recorded` | Verbatim recorded exchange — served by the exact-body short-circuit or `exact_read_recording`. |
| `template` | Synthesized from the WIR model (template constants + holes, session state, error envelopes). The default when no more-specific branch fired. |
| `handler` | Produced by a Lua handler's successful return. |
| `fixture` | Served from a seeded fixture entity (`state/fixtures/`), including a read that overlays fixture-entity fields onto a template. |
| `fault` | A fault or rate-limit injection affected the served response. This includes short-circuit faults (Error/Throttle/Drop/Timeout), rate-limit 429, and Partial faults that truncate a normally rendered body before it reaches the wire. |
| `miss` | A policy-produced fail-closed not-found: the twin had no coverage for this request and the `--unknown-entity not_found` gate (or a route-level miss) fired. The body was synthesized from the route's 4xx variant or the structured-501 route-miss envelope. Distinguishes "the twin is telling you it does not have this" from `recorded` (a verbatim provider 404 replay) and `template` (a synthesized *content* answer). |

> The first five words (`recorded`/`template`/`handler`/`fixture`/`fault`) are
> shared with the per-field `X-Wraith-Provenance-Counts` header. `miss` is a
> per-response word only — the counts-header (per-field origin) vocabulary is
> unchanged.

**Authored routes do not add a word**. A twin may declare routes no
recording covers, in its `lua/routes.toml` sidecar (see
[`wraith route add`](#authored-routes)). Those routes reuse the existing
vocabulary, and the vocabulary above is complete and unchanged:

- Served by a Lua handler → `handler`, exactly as for any other route. This is
  the intended path and the reason the sidecar exists.
- Served from the declaration's own `response` → `template`. Note the nuance:
  `template` here means "synthesized from the model the runtime is serving",
  and that model carried an authored route. It is **not** evidence of a
  recording. `X-Wraith-Route` names the route, and `wraith route list <twin>`
  is the authoritative answer to which routes are authored.
- Declared with neither a handler nor a `response` → `501` with
  `{"error":"authored route has no implementation", …}` and `template`. The
  route exists, nothing implements it, and the body says so rather than
  fabricating a `200`.

### Authored routes

Routes in `lua/routes.toml` are **evidence-free by construction**: they carry
an `authored` artifact origin, they are materialized at serve time only and
never written into `model/symbols.json` or `model/twin.wir.json`, and
`wraith check` neither replays nor scores them. `wraith synth` does not touch
the sidecar, so an authored route survives every re-synth.

If a later recording produces a route with the same method and path, the
**recorded route wins** and the declaration is inert; `wraith serve` warns and
`wraith lint` reports `authored-route-shadowed` (WARN).

`wraith compose` does **not** merge the sidecar into a composite twin. An
input carrying one produces an `authored-routes-not-composed` warning in the
compose envelope; re-declare the routes on the composite.

### `X-Wraith-Route`

Matched route in `METHOD /path` form, e.g. `GET /v3/assets/:id`. Present on
every application response where a route matched. Absent on route-miss 501
responses (no route matched).

Under **synth** fidelity the path is the abstracted route template in wraith
`:param` form. Under **strict**/**permissive** fidelity the path is the
matched recording's concrete request path (e.g. `GET /v3/assets/42`), since
strict replay indexes recorded exchanges by concrete `(method, path)` and has
no template abstraction.

### `X-Wraith-Exchange`

Source exchange identity in `<session_id>/<index>` form. Present **only** when:

- `X-Wraith-Provenance: recorded`, AND
- The synthesized model carries source identity on the `ExactRecording` entry
  (requires a model synthesized by a wraith version that records source
  identity; on older models the header is simply omitted, not an error).

Maps directly to the WREC file at
`recordings/sessions/<session_id>/<index>.wrec.zst`.

### `X-Wraith-Replay`

The twin's claim about how **exactly** the body may be asserted. Present only
when the twin answered from a specific recorded moment; **absent** on every
other response.

```
X-Wraith-Replay: series-moment;v=1
```

**Value grammar.** `<class>;v=<n>[;<parameter>]` — a class token, a decimal
version, and zero or more parameters. Two classes are defined today, and both
license the same strictness:

| Value | Meaning |
|-------|---------|
| `series-moment;v=1` | The body is a **verbatim** moment of the route's per-session exact time axis: the moment that occupied *this request's own position* in the recorded run, with nothing merged into it. Every position of it carries the recording's own value. |
| `session-bound-moment;v=1` | The body is that same moment with **your own values** substituted at the response paths the model proved are session-authored. It answers an *unaddressed* read — one literal path, no query, no body — whose recorded answer, in every observation, repeated a value the same session had supplied in the body of an earlier create. Every other position is the moment's own value. Assert it exactly, as you would a `series-moment`; what you may not expect is the recording's value at the substituted paths. |

**Parameters.** One is defined today. It never changes how strictly you may
assert the body — only which bytes you must compare it against.

| Parameter | Meaning |
|-----------|---------|
| `outbound-policy=applied` | Between choosing the moment and answering you, the twin's declared **outbound policy** rewrote some of these bytes: the self-URL rewrite, the twin's `scrub.toml` rules, the default PII pass, the scrub-placeholder substitution. The body is still that moment position by position — every one of those passes is value-injective — but it is comparable against the recording **in the twin's outbound-policy space**, not against the raw recorded bytes. To diff a recording yourself, put it through the same policy first; `wraith check --target` does this for you. |

Absence of the parameter means the policy changed nothing.

**What "verbatim" covers.** Values at paths, not the octet string. A JSON
moment is held parsed and re-serialized to answer you, so object keys come back
in sorted order and the origin's whitespace is gone — a 529-byte
pretty-printed recording answers as a 307-byte compact body of the same twelve
leaves. Compare parsed documents, not bytes.

`X-Wraith-Provenance: recorded` is strictly weaker and is *not* a substitute.
A `recorded` response may be the last-wins recording of the URL — *a* recording,
not the one this request stood at — or a recorded collection with the session's
own writes merged in. Neither carries `X-Wraith-Replay`. A `HEAD` has no body to
replay and never carries it either.

**Versioning.** The version belongs to the class, and is bumped when the promise
that class makes changes. Split the value on `;`, match every token exactly, and
treat anything you do not recognize as **no claim at all** — a future
`series-moment;v=2`, an unknown class, or an unknown parameter. Never ignore a
token you do not know: a parameter you skip may be the one saying the bytes are
not what you are about to compare them to. A reader written before
`outbound-policy=applied` existed reads a disclosed replay as no claim, which is
the safe reading — as does a reader written before `session-bound-moment;v=1`.

**Fail-closed reading rule.** The absence of a recognized value is *never*
evidence of exactness:

- a twin built before this header existed emits nothing;
- `--no-provenance-headers` suppresses it with the other control headers;
- an intermediary may drop it;
- and the twin may simply have rendered the body.

All four are indistinguishable to a reader and all four mean the same thing:
assert the body the way you would without this contract. A recognized value may
only make a reader assert **more**, never less.

Symmetrically, the twin never emits a claim it cannot keep. The header is
stamped from the same runtime flag `wraith check --in-memory` reads in process,
and any later pass that mutates the bytes — a `Partial` fault truncating the
body, a gRPC re-encode failure — drops the claim along with the provenance tag.

**Who reads it.** `wraith check --target` — the served conformance arm — drops
its render-time relaxations (the model's hole classifications and the
result-set `GeneratedList` policy) for an exchange carrying a recognized claim,
so a replayed body is compared position by position over the wire exactly as it
is in process. An agent harness can use it the same way: a response with this
header can be asserted field-for-field against the recording it came from.

### Opt-out

```sh
# CLI flag (takes precedence over wraith.toml)
wraith serve myapi --no-provenance-headers

# wraith.toml [serve] section
[serve]
provenance_headers = false
```

Suppresses `X-Wraith-Provenance`, `X-Wraith-Route`, `X-Wraith-Exchange`, and
`X-Wraith-Replay` together.

### `X-Wraith-Provenance-Counts` (debug only)

Enabled by `wraith serve --debug` (synth fidelity only). Carries coarse
per-field origin counts for the response body:

```
X-Wraith-Provenance-Counts: recorded=12 template=4 fixture=0 handler=0
```

Vocabulary aligns with the per-response `X-Wraith-Provenance` wire words
(`template` ≈ synthesized, `handler` ≈ authored/Lua) so a harness reads one
vocabulary across both headers.

With `--debug` and `--trace` combined, each trace entry also carries the full
per-field origin map under `origins` — `GET /__wraith/trace/<id>` answers
where every field of that response came from (template constant, echo,
generated, state, fixture, or Lua handler).

Partial faults are different from ordinary rendered JSON: the base response is
rendered first, then the fault layer truncates the bytes. When truncation
actually mutates the body, the whole-response provenance is `fault` and the
per-field counts/origin trace are omitted for that response because the wire
body is intentionally malformed and no longer has a reliable JSON field map.

---

## Fidelity Mode Interactions

`wraith serve --fidelity <strict|synth|fuzzy>` — or `[serve] fidelity` in
`wraith.toml`, which the flag overrides. Default: `synth`.

| Mode | Route miss | Entity miss (unknown id) | Provenance values seen |
|------|-----------|--------------------------|------------------------|
| `synth` (default) | 501 structured miss (`miss`) | synthesized 200 (`template`) or fail-closed 404/501 (`miss`, `not_found` mode) | all six |
| `strict` | 501 structured miss (`miss`, no recordings match) | always fail-closed — strict mode never synthesizes, so an entity miss is inherently a not-found (recorded 4xx → synthesized 4xx → 501) | `recorded`, `fault`, `miss` (no `template` for normal responses) |
| `fuzzy` | **not implemented** — *every* request returns 501, matched route or not | n/a | none (nothing is ever served) |

> **Note**: the mode set is `strict | synth | fuzzy`, identical on the flag and
> in `wraith.toml`. `permissive` is accepted in `wraith.toml` as a deprecated
> alias for `fuzzy`; it does **not** behave like `synth`. `serve` prints a
> warning at startup when `fuzzy` is selected.

In **strict** mode the twin serves only verbatim recorded exchanges. A
request that matches a route but has no exact recorded response gets the
fail-closed treatment regardless of the `--unknown-entity` flag.

---

## All `X-Wraith-*` Response Headers

Every application response (all fidelity modes) may carry the following
control headers. These are wraith control headers, not body PII — they are
exempt from the outbound scrub pipeline.

The outbound scrub pipeline also exempts values the twin **itself minted for
this response**: an identifier the engine invented (a fresh UUID, a generated
token with no recorded prefix) cannot be a recorded secret, so it reaches the
wire in the shape synthesis measured rather than being rewritten into a scrub
token. The exemption is provenance-gated — it applies only to values whose
origin in this response is a mint, never to anything that merely *looks*
generated — and recorded bytes are scrubbed exactly as before.

| Header | Default | Description |
|--------|---------|-------------|
| `X-Wraith-Provenance` | ON | Per-response provenance word: `recorded \| template \| handler \| fixture \| fault \| miss`. Suppressed by `--no-provenance-headers`. |
| `X-Wraith-Route` | ON | Matched route template (`METHOD /path/:param`). Suppressed by `--no-provenance-headers`. |
| `X-Wraith-Exchange` | conditional | `<session_id>/<index>` source identity; present only for `recorded` responses whose model carries source identity. Suppressed by `--no-provenance-headers`. |
| `X-Wraith-Replay` | conditional | Exactness claim for a replayed moment: `series-moment;v=1` (verbatim) or `session-bound-moment;v=1` (that moment with your own session-authored values substituted), optionally `;outbound-policy=applied` when the twin's declared outbound policy rewrote some of the bytes. Absent or unrecognized = no claim (fail-closed). Suppressed by `--no-provenance-headers`. |
| `X-Wraith-Twin-Age` | always | Twin age in whole seconds at server startup (does not tick; divide by 86400 for days). Anchors on the newest recording session; model-only twins fall back to `synth_timestamp`. |
| `X-Wraith-Recorded-At` | when available | RFC 3339 UTC timestamp of the newest source recording. Omitted when the twin has no recordings on disk. |
| `X-Wraith-Provenance-Counts` | `--debug` only | Coarse per-field origin counts (see above). |

The same freshness fields (`twin_age_seconds`, `recorded_at`,
`synthesized_at`, `drifted_routes`) appear in the `--ready-json` envelope and
`GET /__wraith/info` so agents/CI can read freshness without parsing headers.

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
# X-Wraith-Replay: series-moment;v=1
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

See also: `wraith inspect <twin> --provenance` for static per-route provenance
without serving.
