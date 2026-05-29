---
title: GraphQL twins with Wraith
description: "Wraith records, synthesizes, and serves GraphQL APIs without a schema. Per-operation anti-unification, automatic operation routing, and malformed-body fallbacks. Validated at production scale on Linear and Saleor."
---

GraphQL APIs are first-class in Wraith. When `wraith record` sees `POST /graphql` traffic, the synthesis pipeline splits the recordings by operation, builds an anti-unified response per operation, and emits a multi-variant route that dispatches correctly at serve time.

You don't need to ship the schema. Wraith infers the per-operation shape from the recordings the same way it does for REST.

## What gets detected

A route is treated as GraphQL when all three conditions hold:

- HTTP method is **POST**.
- Path ends with `/graphql` (`/graphql`, `/api/graphql`, `/v1/graphql/` all match).
- At least one recorded request body is a JSON object with a non-empty `query` field.

GET requests to `/graphql`, paths like `/graphql-api`, and bodies without a `query` field are treated as regular REST. The detection is strict on purpose.

## How operations are routed

For each request, Wraith resolves an operation key, then routes to the variant synthesized for that operation:

1. **Explicit `operationName`.** If the request body has an `operationName` field set, that's the key.
2. **Parsed query root field.** If `operationName` is missing, Wraith parses the `query` string and extracts the root field (`teams`, `issueCreate`, `viewer`, …). The parser handles the `query`, `mutation`, `subscription` keywords, named operations, variable definitions, and directives.
3. **Fallback `_unknown`.** If neither yields a key, the request lands in the catch-all bucket.

At synthesis time, every operation gets its own anti-unification pass and its own variant. Queries and mutations are routed independently — fields that vary across `issueCreate` exchanges don't leak into `teams` responses.

The guard predicates emitted on the variants are deterministic:

- `FieldEquals` on `$.operationName` when at least one recorded exchange named the operation explicitly.
- `QueryRootField` matching the parsed root field for anonymous queries.

At serve time, the dispatcher evaluates guards left-to-right and the first match wins.

## State ops are off for GraphQL

GraphQL routes are explicitly stamped with `state_op: None`. This is the right answer — `POST /graphql` handles both queries and mutations, so the REST-shaped Create/Read/Update/Delete inference would be wrong. Responses are rendered directly from the variant template, not through the CRUD dispatcher.

If you want stateful behavior on a GraphQL route — a real mutation that should persist — write a [Lua handler](/lua/). It will receive the parsed request and can call into the same per-session state store the REST handlers use.

## Malformed bodies return 400

A `POST /graphql` request whose body is not a JSON object, or whose `query` field is missing or empty, gets a structured 400 response:

```json
{
  "errors": [
    {
      "message": "Must provide query string.",
      "extensions": { "code": "GRAPHQL_VALIDATION_FAILED" }
    }
  ]
}
```

This is automatic — Wraith stamps a `RequestBodyValid` guard on every synthesized variant. Variants for 2xx responses require `RequestBodyValid: true`. A dedicated 4xx catch-all variant requires `RequestBodyValid: false`. The runtime evaluates the guard against every incoming request and routes accordingly.

If your recordings include real 4xx exchanges (validation errors, schema errors), Wraith uses those as the catch-all body. Otherwise it synthesizes the spec-compliant fallback above.

## At production scale

Two GraphQL twins ship in the test corpus and validate the approach at real-world scale:

- **Linear** — 21 operation variants on `POST /graphql`, including mutations like `issueCreate`, `issueArchive`, `commentCreate` and queries like `teams`, `viewer`, `issue`.
- **Saleor** — 17 operation variants on `POST /graphql/`, mixing storefront queries with admin mutations.

Both twins serve at zero divergences against their recordings. If you've used wraith for REST APIs and were waiting on GraphQL support before twinning your own GraphQL backend — this is it.

## Known limitations

Two surfaces are documented but not yet handled:

- **Batched queries** (`[{query: "..."}, {query: "..."}]`). Wraith's operation extractor expects a JSON object at the root, so batched requests currently fall into the `_unknown` bucket — the request still gets a response, but operation routing is lost across the batch.
- **Persisted queries** (`{persistedQuery: {sha256Hash: "..."}}`). The body has no `query` field, so detection falls through to `_unknown`. The hash-to-query mapping is client-side and not visible to Wraith.

Both are tracked as gaps; if you're hitting either in real traffic, it's worth filing a note.

## Workflow

Standard record → synth → check → serve loop:

```sh
wraith init linear --base-url https://api.linear.app
wraith record linear --port 8080

# Exercise the real API through localhost:8080 — wraith captures the operations
# along with their request bodies and response bodies.

wraith synth linear         # one variant per detected operation
wraith check linear         # confirm conformance across the recorded operations
wraith serve linear         # serve at localhost:8081
```

Point your GraphQL client at `http://localhost:8081/graphql` and it sees the same operations, the same response shapes, and the same error envelopes — without paying the upstream API or running its infrastructure.
