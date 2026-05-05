---
title: Seed recorded API mocks from OpenAPI specs
description: Generate scenario plans from OpenAPI, smoke-check live services, and measure recording coverage for Wraith API twins.
---

Wraith's primary workflow is record -> synthesize -> verify, with no spec required. But when you *do* have an OpenAPI 3.x spec, you can use it two ways:

1. **Seed**: generate a scenario plan from the spec and (optionally) execute it against a live API to produce recordings.
2. **Measure coverage**: compare what's in your recordings to what the spec declares, and surface the gaps.

Both are additive - they complement recording, they don't replace it. The recorded behaviour still wins for synthesis.

## `wraith explore`

```sh
wraith explore --from-openapi petstore.yaml
```

Parses the spec and prints a scenario plan: a structured list of request sequences that together exercise every operation. No network, no writes - just a plan you can review.

With `--against <url>`, the plan is executed:

```sh
wraith explore --from-openapi petstore.yaml \
  --against https://petstore.example.com \
  --header "Authorization: Bearer $TOKEN"
```

Each scenario's steps are sent via async reqwest. The output reports per-step outcomes (`match`, `mismatch`, `error`) alongside the plan.

### Flags

| Flag               | Description                                              |
|--------------------|----------------------------------------------------------|
| `--from-openapi`   | Path to spec (YAML or JSON)                              |
| `--against`        | Optional live URL to execute scenarios against           |
| `--header`         | Repeatable `"Name: Value"` headers for auth              |
| `--max-scenarios`  | Cap the number of scenarios (safety bound)               |
| `--format`         | Output format: `pretty`, `text`, `json` (auto-detects)   |

### JSON output shape

```json
{
  "api_title": "Petstore",
  "count": 4,
  "operations_covered": 3,
  "scenarios": [
    {
      "name": "petstore.pets.crud_lifecycle",
      "category": "crud_lifecycle",
      "step_count": 3,
      "entities": ["pet"],
      "priority": 1
    }
  ],
  "plan": { "...": "full ScenarioPlan" },
  "execution": {
    "base_url": "https://petstore.example.com",
    "total_steps": 7,
    "matched_steps": 5,
    "mismatched_steps": 1,
    "error_steps": 1,
    "results": [
      {
        "scenario": "petstore.pets.crud_lifecycle",
        "steps": [
          { "method": "GET", "path": "/pets/{id}", "expected_status": 200, "observed_status": 200, "outcome": "match" }
        ]
      }
    ]
  },
  "advice": [{ "level": "info", "type": "plan-only", "message": "..." }]
}
```

`execution` is present only when `--against` is set.

### Preview vs. recording

`--against` does **not** capture WRECs. It's a preview / smoke check - useful for "does this spec actually describe the service" or "which operations are live?" For real recordings, use `wraith record` and exercise the twin the usual way. The two tools complement each other:

```sh
# 1. Preview: does the spec match reality?
wraith explore --from-openapi petstore.yaml --against https://api.example.com

# 2. Record: capture the traffic for the twin
wraith record myapi --port 8080
# ... exercise the API through the proxy ...

# 3. Cover: which operations from the spec are in the recordings?
wraith coverage myapi --openapi petstore.yaml
```

## `wraith coverage --openapi`

Extends the existing coverage command to compute spec-vs-recordings gap.

```sh
wraith coverage myapi --openapi petstore.yaml
```

Walks every recorded session and matches request paths against spec templates (treating `{param}` as wildcards). Reports what's covered and what isn't:

```json
{
  "coverage": {
    "route_coverage": { "...existing...": "..." },
    "state_coverage": null,
    "spec_coverage": {
      "api_title": "Petstore",
      "covered_count": 2,
      "total_count": 3,
      "percentage": 0.667,
      "uncovered_operations": [
        { "method": "GET", "path": "/pets/{id}" }
      ],
      "manifest": { "...": "full CoverageManifest" }
    }
  },
  "advice": [
    { "level": "info", "type": "spec-coverage-primary", "message": "Route coverage reflects synthesized twin; spec coverage reflects the raw API surface in recordings." }
  ]
}
```

The pre-existing `route_coverage` field is unchanged - it reports coverage against the synthesized twin's routes. The new `spec_coverage` reports coverage against the raw API surface declared in the spec. They answer different questions:

- `route_coverage` asks: *how much of my twin is exercised by my tests?*
- `spec_coverage` asks: *how much of the real API surface is in my recordings?*

Both are useful; both ship side by side.

## When to use OpenAPI seed mode

- You have a spec and want a smoke check against a staging or preview deployment before committing to a recording run.
- You want to quantify your recording coverage ("we have WRECs for 42 of the 68 documented operations, here's the gap list").
- You're onboarding a new API and want a starting plan for what to exercise.

When **not** to use it:

- The spec is aspirational and doesn't match reality. (Most public specs are.) Record the real traffic; the spec lies. `wraith explore --against` will surface this quickly.
- You already have thorough recordings. Nothing to add.

## Auth

OpenAPI security schemes are surfaced in the plan but wraith doesn't automatically source credentials - pass them via `--header` at execution time:

```sh
wraith explore --from-openapi stripe.yaml \
  --against https://api.stripe.com \
  --header "Authorization: Bearer $STRIPE_KEY"
```

For schemes beyond Bearer / API key (OAuth flows, signed requests), you'll typically want to record real traffic anyway.
