---
title: Sandboxing agents with Wraith
description: Run parallel agents against deterministic Wraith API twins with X-Wraith-Session isolation, fixture provisioning, deterministic clocks, per-session reset, and fail-closed misses.
---

Agent runs need an API world that is local, repeatable, isolated, and honest
about missing coverage. Wraith gives you that with one served twin process and
one session namespace per agent.

The supported pattern is:

- start the twin with deterministic serve settings and a ready JSON file;
- give each agent a unique `X-Wraith-Session` header value;
- provision fixture, seed, and clock per session when agents need different
  starting worlds;
- use per-session reset or delete for cleanup;
- fall back to one process per agent only when the client cannot set headers or
  the workflow needs different serve-wide flags.

## Start the sandbox

```sh
wraith serve checkout \
  --port 0 \
  --ready-json /tmp/wraith-checkout-ready.json \
  --unknown-entity not_found \
  --fixture baseline \
  --seed 42 \
  --clock deterministic \
  --clock-epoch 1700000000 &

URL=$(jq -r .serve.url /tmp/wraith-checkout-ready.json)
SESSION_HEADER=$(jq -r .serve.wraith_session_header /tmp/wraith-checkout-ready.json)
```

`--port 0` avoids collisions when many jobs run on the same host.
`--ready-json` is the machine-readable startup contract: it publishes the bound
URL, the session header name, freshness fields, and control endpoint paths.

Use `--unknown-entity not_found` for agent-facing twins. If an agent asks for
an entity id the twin never observed and did not seed or create in that
session, Wraith returns a provider-shaped not-found when it has one, or a
structured 501 miss. Without this flag, the default development mode may
synthesize a template-shaped 200 for the unknown id.

## Isolate each agent

Every request from one agent should carry one stable session id:

```sh
AGENT_SESSION="agent-${CI_NODE_INDEX:-0}-${GITHUB_RUN_ID:-local}"

curl -sS "$URL/v1/customers" \
  -H "$SESSION_HEADER: $AGENT_SESSION"
```

Stateful creates, updates, deletes, generated ids, counters, idempotency
caches, seeded fixtures, and deterministic clocks are scoped to that session
namespace. Requests without `X-Wraith-Session` share the default namespace, so
avoid the headerless path in parallel harnesses.

## Provision fixture, seed, and clock per session

If every agent can start from the same fixture set, `wraith serve --fixture`
is enough. If each agent needs a different world, provision its session before
the first business request:

```sh
curl -sS -X POST "$URL/__wraith/session" \
  -H 'content-type: application/json' \
  -d '{
    "session": "agent-17",
    "fixture": "checkout:happy-path",
    "seed": 17017,
    "clock": {
      "mode": "deterministic",
      "base_epoch": 1700000000
    }
  }'
```

The response names what was installed:

```json
{
  "session": "agent-17",
  "fixture": "checkout:happy-path",
  "seed": 17017,
  "clock": { "mode": "deterministic", "base_epoch": 1700000000 },
  "entities_seeded": 12
}
```

Clock modes are `real`, `deterministic`, and `fixed`. `base_epoch` and
`base_epoch_secs` are both accepted. A second provisioning call with different
settings for the same session returns `session-provision-conflict`; an unknown
fixture returns `fixture-not-found` and lists the available fixture sets.

Fixture sets are documented in [Fixtures & state](/fixtures/). They are loaded
once when a session namespace is created.

## Reset one agent, not all agents

Use the per-session lifecycle endpoints during parallel runs:

```sh
# Reset state for one session, keeping its provisioned fixture/seed/clock.
curl -sS -X POST "$URL/__wraith/session/$AGENT_SESSION/reset"

# Drop one session namespace and its provisioning record.
curl -sS -X DELETE "$URL/__wraith/session/$AGENT_SESSION"

# List active and explicitly provisioned namespaces.
curl -sS "$URL/__wraith/session" | jq .
```

`POST /__wraith/reset` is global. It resets every session in that served
process, which is useful for a single developer loop and dangerous for shared
parallel agents.

With `--debug`, you can inspect an existing namespace without creating missing
state:

```sh
curl -sS "$URL/__wraith/session/$AGENT_SESSION/state" | jq .
```

## Read provenance and misses

Every served application response carries Wraith control headers by default.
For agent harnesses, the important ones are:

| Header | Use |
|--------|-----|
| `X-Wraith-Provenance` | Distinguish `recorded`, `template`, `handler`, `fixture`, `fault`, and `miss`. |
| `X-Wraith-Route` | See the matched route template. |
| `X-Wraith-Exchange` | Trace recorded responses back to `<session>/<index>`. |
| `X-Wraith-Twin-Age` / `X-Wraith-Recorded-At` | Detect stale twins without parsing logs. |

`X-Wraith-Provenance: miss` means Wraith made a policy-produced coverage
decision: route miss or fail-closed entity miss. It is different from a
verbatim recorded provider 404 (`recorded`) and from a synthesized answer
(`template`). See the [Twin Response Contract](/twin-response-contract/) for
the full table.

## HMAC key caveat

Wraith tokenizes scrubbed values with an HMAC key. The same input produces the
same scrub token only when the same key is used. In CI, set a stable
`WRAITH_HMAC_KEY` before recording, packing, or comparing artifacts whose
scrubbed values or digests must remain stable:

```sh
export WRAITH_HMAC_KEY="$CI_WRAITH_HMAC_KEY"
```

Do not commit the key. Rotating it is allowed, but it changes scrub tokens and
can change packed twin digests in digest-pinned workflows.

This key is not provider auth. Recorded credentials are scrubbed; live provider
runs still need credentials injected by your harness or by the intent-contract
auth environment.

## Outbound scrub and fixtures

Wraith also scrubs synthesized responses on serve. Values under PII-shaped
field names such as `name`, `email`, `phone`, and `login` may be tokenized on
the wire even if they came from synthetic fixture data or the current agent's
request. If fixture values are deliberately non-sensitive and must round-trip
verbatim, configure the twin's PII policy explicitly.

## Process-per-agent fallback

Prefer one shared server plus `X-Wraith-Session`. Start one `wraith serve`
process per agent when:

- the client cannot reliably send custom headers;
- the test mutates global control-plane state;
- agents need different serve-wide flags such as `--fault-profile`,
  `--rate-limit`, `--clock`, or `--fixture`;
- you need operating-system isolation for logs, ports, or process lifetime.

```sh
wraith serve checkout \
  --port 0 \
  --ready-json "/tmp/wraith-$AGENT_ID.json" \
  --unknown-entity not_found \
  --fixture "$AGENT_FIXTURE" \
  --seed "$AGENT_SEED" \
  --clock deterministic \
  --clock-epoch 1700000000 &
```

In that fallback, each process has its own default namespace and global reset
surface, so `POST /__wraith/reset` is scoped to that one agent process.

## Multi-twin projects

`wraith up` forwards manifest-level fixture, clock, clock epoch, and
control-token settings into each child `wraith serve` process:

```toml
# wraith-project.toml
[[twins]]
name = "billing"
port = 8081
fixture = "checkout:happy-path"
clock = "deterministic"
clock_epoch = 1700000000
control_token_env = "WRAITH_CONTROL_TOKEN"
```

```sh
wraith up
wraith env --format json
```

When one agent calls several twins, use the same `X-Wraith-Session` value on
every request to every twin so each API sees that agent's isolated namespace.

## Control-plane auth

Loopback binds allow `/__wraith/*` control endpoints without authentication.
Non-loopback binds require `--control-token-env`, and non-exempt control
requests must send `Authorization: Bearer <token>`. Health, ready, and info
remain unauthenticated.

Do not expose a shared agent sandbox on a non-loopback address without a
control token. Session reset and delete are intentionally powerful.
