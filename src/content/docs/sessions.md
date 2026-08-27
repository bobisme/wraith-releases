---
title: Session isolation
description: The session contract for Wraith twins — what a session scopes, how session namespaces are created and capped, what resets them, and what stays shared across a served process.
---

A **session** is Wraith's unit of state isolation. Every session gets its own
namespace: its own entities, its own generated ids, its own clock. Two sessions
talking to the same twin cannot see each other's writes.

This page is the contract. For the task-oriented walkthrough, see
[Sandboxing agents](/sandboxing-agents/).

## The scope unit

A session is identified by the value of the `X-Wraith-Session` request header.
Every request carrying the same value lands in the same namespace.

```sh
curl -sS "$URL/v1/customers" -H 'X-Wraith-Session: worker-3'
```

The header value is used **verbatim** as the namespace key. It is opaque to
Wraith: exact-match, case-sensitive, no normalization, no format requirement.
`worker-3` and `Worker-3` are two different sessions.

**Requests without the header share one default namespace.** That is a real
namespace, not a bypass — it just happens to be shared by everyone who omitted
the header. In a parallel harness, a client that forgets the header silently
joins that shared world. The header is the entire isolation mechanism.

## What a session scopes

| Scoped per session | Notes |
|---|---|
| State store | Entities created, updated, and deleted during the session |
| Generated ids | Each namespace has its own seeded id generator |
| Random values | Independent seeded RNG per namespace |
| Clock | Mode and base epoch are per namespace |
| Named counters | Counter holes in response templates |
| Idempotency cache | `Idempotency-Key` replays, keyed within the session |
| Fixture seed | Loaded once, when the namespace is created |
| List-route merges | A recorded collection is replayed with *this* session's writes merged in |

## What stays shared

These are properties of the served process, not of a session. Every session
sees the same values:

- the loaded twin model, its routes and variants;
- fault and chaos injection (`--fault-profile`, `--chaos-seed`);
- latency policy (`--latency-mode` and friends);
- rate-limit configuration (`--rate-limit`, `--rate-limit-override`);
- the request trace ring buffer (`--trace`) and access log;
- serve-wide flags such as `--unknown-entity` and `--fidelity`.

If two agents need different values for any of those, they need different
`wraith serve` processes — sessions will not separate them.

## Lifecycle

A namespace is created either **lazily**, on the first request bearing a
session value Wraith has not seen, or **eagerly**, via `POST /__wraith/session`
when you want to pin its fixture, seed, and clock before any traffic arrives.

Once created, a namespace lives until something removes it. **Namespaces do not
expire.** There is no TTL and no least-recently-used eviction — an idle session
holds its slot indefinitely.

Concurrent namespaces are capped by `max_namespaces` under `[serve.limits]`,
default **1000**. At the cap, Wraith **fails closed and says so**: creating a
new namespace returns `503` rather than silently reusing or evicting one.

```json
{
  "error": "namespace-unavailable",
  "message": "namespace limit exceeded (max 1000)"
}
```

A long-lived shared twin that mints a fresh random session id per test will
reach the cap eventually. Delete sessions at teardown and it never will.

## What resets a session

| Action | Scope | Keeps provisioning? |
|---|---|---|
| `POST /__wraith/session/{id}/reset` | One session | Yes — fixture, seed, and clock are kept and the fixture is re-seeded immediately |
| `DELETE /__wraith/session/{id}` | One session | No — drops the provisioning record and frees the slot |
| `POST /__wraith/reset` | **Every session in the process** | State is cleared for all sessions |
| Restarting `wraith serve` | Everything | Clean slate |

```sh
# Reset one worker's world between test files, keeping its fixture.
curl -sS -X POST "$URL/__wraith/session/worker-3/reset"

# Release the slot when the worker exits.
curl -sS -X DELETE "$URL/__wraith/session/worker-3"

# Who is still holding a namespace?
curl -sS "$URL/__wraith/session" | jq .
```

Use the per-session endpoints in parallel runs. `POST /__wraith/reset` is
global — convenient in a single-developer loop, destructive to everyone else's
in-flight tests on a shared server.

When `--rate-limit` is enabled, rate-limit counters follow the same rules:
the per-session reset and teardown clear that session's counters, the global
reset clears every session's, and a torn-down session id reused later starts
with a fresh quota.

## Nothing persists to disk

All session state is in memory. Wraith never writes namespace state to disk, so
a restarted twin is always a clean slate — there is no state file to remove and
no stale directory to clear between runs.

The practical consequence for CI: **if each CI run starts its own `wraith serve`
process, you need no reset step at all.** Reset endpoints exist for reusing a
long-lived server, not for cleaning up after one.

## CI patterns

**One server, one session per worker.** The recommended shape. Start a single
twin, give every test worker a session id derived from its identity, and delete
the session on teardown.

```sh
wraith serve checkout \
  --port 0 \
  --ready-json /tmp/wraith-ready.json \
  --unknown-entity not_found \
  --fixture baseline \
  --seed 42 \
  --clock deterministic \
  --clock-epoch 1700000000 &

URL=$(jq -r .serve.url /tmp/wraith-ready.json)
SESSION="ci-${GITHUB_RUN_ID}-${WORKER_INDEX}"

# ... run tests, sending `X-Wraith-Session: $SESSION` on every request ...

curl -sS -X DELETE "$URL/__wraith/session/$SESSION"
```

Include a run identifier in the session id. Reusing bare worker indexes across
runs on a shared server means run *N+1* inherits run *N*'s state.

**One process per job.** Simpler, and required when the client cannot set
headers or when jobs need different serve-wide flags. Each process has its own
default namespace, so the headerless path is safe and `POST /__wraith/reset` is
scoped to that job.

## Sessions across multiple twins

When one agent calls several twins, send the **same** session id to all of them.
Each twin keeps its own independent namespace under that id, so the agent gets a
consistent isolated world across every API it touches.

## Exposing the control plane

Loopback binds allow `/__wraith/*` without authentication. Non-loopback binds
require a control token (`--control-token-env` or `--control-token-file`), and
control requests must send `Authorization: Bearer <token>`. Health, ready, and
info stay unauthenticated.

Session reset and delete are powerful by design. Do not put a shared sandbox on
a non-loopback address without a token.

## See also

- [Sandboxing agents](/sandboxing-agents/) — the end-to-end parallel-agent workflow
- [Fixtures & state](/fixtures/) — what gets seeded into a new namespace
- [Configuration](/configuration/) — `[serve.limits]` and other serve settings
- [Twin Response Contract](/twin-response-contract/) — response headers and provenance
