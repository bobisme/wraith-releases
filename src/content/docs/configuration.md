---
title: Configure Wraith API twins and scrubbing rules
description: Reference every wraith.toml, scrub.toml, and drift.toml setting for local API twins, scrubbing, drift handling, and serving behavior.
---

Wraith uses TOML files per twin workspace to control behaviour, security policy, and drift handling.

## File Locations

```
twins/<name>/
├── wraith.toml    # Twin behaviour, thresholds, generation settings
├── scrub.toml     # Security scrubbing rules
└── drift.toml     # (optional) Drift suppression / reclassification hints
```

`wraith.toml` and `scrub.toml` are created automatically by `wraith init`. `drift.toml` is optional; add it only when `wraith check` reports drifts you want to suppress or reclassify.

Runtime simulation (fault injection, latency, rate limiting, tracing) is configured via CLI flags on `wraith serve`, not through `wraith.toml`. See [Simulation](/simulation/) for the full reference.

---

## wraith.toml

### `[service]` (required)

| Field      | Type   | Default | Description                                  |
|------------|--------|---------|----------------------------------------------|
| `name`     | string | required | Twin name (directory name under `twins/`)    |
| `base_url` | string | required | Upstream API base URL                        |
| `spec`     | string | not set  | Optional path to OpenAPI spec                |

### `[proxy]`

| Field  | Type   | Default     | Description                        |
|--------|--------|-------------|------------------------------------|
| `mode` | string | `"reverse"` | Proxy mode: `reverse` or `forward` |
| `port` | u16    | `8080`      | Port the recording proxy binds to  |

### `[serve]`

| Field                | Type   | Default    | Description                                      |
|----------------------|--------|------------|--------------------------------------------------|
| `port`               | u16    | `8081`     | Port the twin server binds to                    |
| `session_mode`       | string | `"header"` | Session isolation: `header`, `cookie`, or `path` |
| `fidelity`           | string | `"synth"`  | Response mode: `strict` or `synth` (`permissive` is reserved, not yet implemented) |
| `deterministic_seed` | u64    | `42`       | Seed for deterministic random generation         |
| `debug`              | bool   | `false`    | Enable debug response headers                    |
| `strip_headers`      | bool   | `true`     | Strip non-allowlisted response headers (vendor `cf-*`, `x-cache`, `x-served-by`, `x-powered-by`, `nel`, `report-to`, etc.). Set to `false` to replay every recorded header verbatim. |
| `rewrite_self_urls`  | bool   | `true`     | Rewrite absolute URLs whose host matches `service.base_url` (response bodies and `Location:`) to point back at the twin so clients don't leak off following next-page or related-resource URLs. |

### `[serve.latency]`

| Field        | Type   | Default  | Description                              |
|--------------|--------|----------|------------------------------------------|
| `mode`       | string | `"none"` | `none`, `recorded`, `scaled`, or `fixed` |
| `min_ms`     | u64    | `0`      | Minimum simulated latency (ms)           |
| `max_ms`     | u64    | `5000`   | Maximum simulated latency (ms)           |
| `multiplier` | f64    | `1.0`    | Multiply recorded latency by this factor |

### `[serve.limits]`

| Field                      | Type | Default | Description                          |
|----------------------------|------|---------|--------------------------------------|
| `max_entities_per_type`    | u64  | `10000` | Max entities per resource type       |
| `max_total_state_mb`       | u64  | `100`   | Max in-memory state (MB)             |
| `max_namespaces`           | u64  | `1000`  | Max concurrent session namespaces    |
| `request_drain_timeout_ms` | u64  | `5000`  | Graceful shutdown drain timeout (ms) |

### `[serve.rate_limits.<pattern>]`

| Field            | Type | Description                   |
|------------------|------|-------------------------------|
| `limit`          | u64  | Max requests per window       |
| `window_seconds` | u64  | Window duration in seconds    |

### `[serve.clock]`

Resolution policy for `created` / `created_at` / `updated_at` timestamp holes. `real` (the default) reads `SystemTime::now()` per request so sequential creates produce strictly-increasing timestamps — matches every real API. `deterministic` advances a seed-derived monotonic counter from `base_epoch` for byte-identical golden replay. `fixed` freezes the clock at `base_epoch`.

| Field        | Type   | Default      | Description                                                   |
|--------------|--------|--------------|---------------------------------------------------------------|
| `mode`       | string | `"real"`     | `real`, `deterministic`, or `fixed`                           |
| `base_epoch` | u64    | `1640995200` | Unix seconds. Starting value for `deterministic`; frozen value for `fixed`. Ignored when `mode = real`. |

### `[serve.idempotency]`

Replay cache for `Idempotency-Key`-style POST headers. Disabled by default so non-Stripe twins don't inadvertently get the behavior surprise — opt in per twin.

| Field         | Type   | Default            | Description                                                  |
|---------------|--------|--------------------|--------------------------------------------------------------|
| `enabled`     | bool   | `false`            | Master toggle                                                |
| `header`      | string | `"Idempotency-Key"` | Header carrying the idempotency key                          |
| `ttl_seconds` | u64    | `86400`            | Cache entry TTL. Stale entries are lazily evicted on lookup. |

```toml
[serve.idempotency]
enabled = true
header = "Idempotency-Key"
ttl_seconds = 86400
```

### `[serve.lua]`

| Field      | Type   | Default  | Description                                                |
|------------|--------|----------|------------------------------------------------------------|
| `on_error` | string | `"fail"` | `"fail"` returns HTTP 500 + structured JSON envelope when a Lua handler raises. `"fallback"` falls through to the synth template engine (legacy pre-v0.6.0 behavior; hid handler bugs from conformance, opt-in only). |

### `[diff]`

| Field               | Type | Default | Description                           |
|---------------------|------|---------|---------------------------------------|
| `required_score`    | f64  | `0.90`  | Minimum overall conformance score     |
| `session_pass_rate` | f64  | `0.95`  | Minimum fraction of passing sessions  |
| `scoring_version`   | u32  | `1`     | Scoring algorithm version             |

### `[diff.thresholds]`

| Field                | Type | Default | Description                         |
|----------------------|------|---------|-------------------------------------|
| `status_exact_match` | bool | `true`  | Require exact HTTP status match     |
| `body_structure`     | f64  | `0.90`  | Min structural similarity [0, 1]    |
| `body_values`        | f64  | `0.85`  | Min value similarity [0, 1]         |
| `symbol_consistency` | f64  | `1.0`   | Required symbol/token consistency   |
| `header_conformance` | f64  | `0.80`  | Min response header conformance     |

### `[diff.overrides."METHOD /path"]`

Per-route threshold overrides. Same fields as `[diff.thresholds]` but all optional.

```toml
[diff.overrides."POST /v1/charges"]
body_structure = 0.95
body_values = 0.95
```

### `[diff.fields."<json_path>"]`

Override field classifications for specific JSON paths. Use hole-style paths (no `body.` prefix - it's added automatically).

| Field      | Type   | Required | Description                                     |
|------------|--------|----------|-------------------------------------------------|
| `classify` | string | yes      | `"generated"`, `"timestamp"`, `"constant"`, or `"echoed"` |
| `values`   | string[] | no     | Allowed values when `classify = "enum"`          |

```toml
[diff.fields]
# Force exact comparison on computed fields (not auto-suppressed)
"total" = { classify = "constant" }
"summary.total_value" = { classify = "constant" }

# Treat a field as a timestamp (type-only comparison)
"expires_at" = { classify = "timestamp" }
```

User-supplied classifications always override auto-detected ones.

### `[[diff.suppress]]`

Suppress specific divergences by route, path, and/or category. Supports `*` wildcards.

| Field      | Type   | Required | Description                            |
|------------|--------|----------|----------------------------------------|
| `route`    | string | no       | Route pattern (e.g. `"POST /repos/*"`) |
| `path`     | string | no       | JSON path (e.g. `"body.created_at"`)   |
| `category` | string | no       | Divergence category (e.g. `"value_mismatch"`) |
| `reason`   | string | yes      | Human-readable explanation             |

```toml
[[diff.suppress]]
path = "body.created_at"
reason = "twin uses placeholder timestamps"

[[diff.suppress]]
route = "POST /repos/*/statuses/*"
category = "value_mismatch"
reason = "commit status fields are state-dependent"
```

Suppressed divergences are excluded from scoring but listed by `--show-suppressed`.

### `[generate]`

| Field                  | Type | Default   | Description                           |
|------------------------|------|-----------|---------------------------------------|
| `max_iterations`       | u32  | `10`      | Max agent optimisation iterations     |
| `token_budget`         | u64  | `200000`  | LLM token budget per generation run   |
| `time_budget_minutes`  | u32  | `30`      | Time limit for generation run         |
| `regression_tolerance` | f64  | `0.0`     | Acceptable conformance regression     |

### `[generate.symbolization]`

| Field                      | Type | Default | Description                             |
|----------------------------|------|---------|-----------------------------------------|
| `entropy_threshold`        | f64  | `4.5`   | Shannon entropy cutoff for symbol detection |
| `min_string_length`        | u32  | `4`     | Ignore strings shorter than this        |
| `exclude_urls`             | bool | `true`  | Don't symbolise URL-like values         |
| `exclude_natural_language` | bool | `true`  | Don't symbolise natural language        |
| `field_name_hinting`       | bool | `true`  | Use field names to guide symbolisation  |

### `[generate.anti_unification]`

| Field                        | Type             | Default    | Description                             |
|------------------------------|------------------|------------|-----------------------------------------|
| `min_exchanges_per_route`    | u32              | `3`        | Min exchanges before pattern extraction |
| `low_confidence_threshold`   | f64              | `0.20`     | Below this, route is flagged low-conf   |
| `array_mode`                 | string           | `"schema"` | `schema` or `element`                   |
| `array_length`               | string           | `"median"` | Length policy for variable-length arrays. `median` (default; back-compatible) collapses bimodal corpora — use `p75`, `p90`, or `max` for catalog / search APIs. |
| `drop_empty_array_responses` | bool             | `false`    | When `true`, responses whose every array is empty are excluded from anti-unification per status group (only when at least one non-empty response exists for that group — never prunes to zero). |
| `max_array_representatives`  | integer or `"all"` | `8`      | Distinct elements retained per variable-length array. Integer `N` keeps a deterministic sample of up to N elements in first-seen order. `"all"` retains every distinct element. |

```toml
# Recommended config for bimodal / search APIs
[generate.anti_unification]
array_length = "p90"
drop_empty_array_responses = true
max_array_representatives = "all"   # or a bound like 200
```

### `[generate.request_keying]`

Recovers request → response correlation when a route's response depends on a request field (a parent id, a `useCase` scope, a search filter). Without this, synth collapses every value to one global representative.

| Field  | Type   | Default | Description                                                |
|--------|--------|---------|------------------------------------------------------------|
| `mode` | string | `"off"` | `off` (inert; pre-v0.8.0 behavior), `manual`, or `auto`. `auto` additionally detects keys for unruled routes when one strongly predicts the response. |

### `[[generate.request_keying.route]]`

Explicit per-route rules. Honored under both `manual` and `auto`.

| Field    | Type     | Required | Description                                            |
|----------|----------|----------|--------------------------------------------------------|
| `route`  | string   | yes      | `"METHOD /path/pattern"` matching the synthesized path |
| `fields` | string[] | yes      | Request-body JSON paths (`$.a.b.c`). Multiple fields form a composite key. |

```toml
[generate.request_keying]
mode = "manual"

[[generate.request_keying.route]]
route  = "POST /v1/assets/actions/search"
fields = ["$.bulksearchv1AssetsInput.filter.parentId"]
```

### `[generate.route_normalization]`

| Field                      | Type | Default | Description                         |
|----------------------------|------|---------|-------------------------------------|
| `numeric_ids`              | bool | `true`  | Collapse `/users/123` -> `/users/:id` |
| `prefix_pattern_ids`       | bool | `true`  | Collapse prefix-style IDs            |
| `value_flow_confirmation`  | bool | `true`  | Use value-flow graph to confirm      |
| `structural_alignment`     | bool | `false` | Experimental structural alignment    |

### `[generate.guard_inference]`

| Field              | Type   | Default           | Description                    |
|--------------------|--------|-------------------|--------------------------------|
| `algorithm`        | string | `"decision_tree"` | `decision_tree` or `rule_list` |
| `max_depth`        | u32    | `4`               | Max decision tree depth        |
| `z3_minimization`  | bool   | `false`           | Use Z3 to minimise guards      |

### `[generate.type_inference]`

| Field                     | Type | Default | Description                          |
|---------------------------|------|---------|--------------------------------------|
| `cross_route_unification` | bool | `true`  | Unify types across routes            |
| `enum_max_values`         | u32  | `5`     | Max distinct values before non-enum  |
| `enum_min_samples`        | u32  | `3`     | Min samples to confirm enum type     |

### `[generate.routing]`

| Field            | Type     | Default | Description                          |
|------------------|----------|---------|--------------------------------------|
| `default_runner` | string?  | not set  | Default LLM runner name              |
| `fallback`       | string[] | `[]`    | Fallback runner chain                |
| `air_gapped`     | bool     | `false` | Disable all network-based runners    |

### `[generate.runners.<name>]`

| Field     | Type     | Default | Description                     |
|-----------|----------|---------|---------------------------------|
| `command` | string   | required | Runner executable               |
| `args`    | string[] | `[]`    | Command-line arguments          |
| `format`  | string?  | not set  | Output format (`json`, etc.)    |

### `[refresh]`

| Field              | Type   | Default           | Description                     |
|--------------------|--------|-------------------|---------------------------------|
| `sample_strategy`  | string | `"risk_weighted"` | `risk_weighted`, `random`, `coverage` |
| `budget_requests`  | u64    | `500`             | Max requests per refresh cycle  |

### `[recordings]`

| Field               | Type | Default | Description                        |
|---------------------|------|---------|------------------------------------|
| `max_sessions`      | u64  | `1000`  | Max recording sessions retained    |
| `max_total_size_mb` | u64  | `5000`  | Max total recording size (MB)      |
| `retention_days`    | u64  | `90`    | Delete recordings older than this  |
| `max_body_size_mb`  | u64  | `10`    | Max body size per exchange (MB)    |

### `[passthrough]`

| Field     | Type     | Default | Description                              |
|-----------|----------|---------|------------------------------------------|
| `enabled` | bool     | `false` | Forward unmatched requests to upstream   |
| `allow`   | string[] | `[]`    | Route patterns allowed for passthrough   |

### `[base]` (overlay twins only)

A twin becomes an overlay when `wraith.toml` carries a `[base]` section. Without it, the twin is a "root" twin and overlay code paths are inert. See [Overlays](/overlays/) for the full reference.

| Field                  | Type   | Required | Description                                       |
|------------------------|--------|----------|---------------------------------------------------|
| `artifact`             | string | yes      | Artifact id of the provider twin                  |
| `digest`               | string | yes      | Content digest of the provider's model (`sha256:<64 hex>`) — pins the overlay to a specific base version |
| `model_schema_version` | u32    | yes      | Schema version of the provider twin's model       |
| `scrub_policy_hash`    | string | yes      | Hash of the provider twin's scrub policy          |

### `[overlay]` (overlay twins only)

Optional metadata describing the overlay twin.

| Field         | Type     | Required | Description                                                  |
|---------------|----------|----------|--------------------------------------------------------------|
| `owner`       | string   | yes      | Owner of the overlay (e.g. team name) — required by `wraith doctor` / `wraith lint` |
| `description` | string   | no       | Overlay purpose and scope                                    |
| `requires`    | string[] | no       | Declared dependencies on overlay artifacts (`name@sha256:<64 hex>`) |

### `[capabilities]` (overlay twins only)

Permitted modifications. Defaults prevent accidental data loss; only set when explicitly opting into more invasive changes.

| Field                   | Type | Default | Description                                       |
|-------------------------|------|---------|---------------------------------------------------|
| `add_routes`            | bool | `true`  | Allow adding new routes                           |
| `add_variants`          | bool | `true`  | Allow adding disjoint variants on existing routes |
| `add_schema_extensions` | bool | `true`  | Allow extending the schema                        |
| `add_fixture_sets`      | bool | `true`  | Allow adding new fixture sets                     |
| `add_fault_profiles`    | bool | `true`  | Allow adding new fault profiles                   |
| `add_lua_handlers`      | bool | `false` | Allow adding Lua handlers                         |
| `override_variants`     | bool | `false` | Allow overriding existing variants                |
| `override_fixtures`     | bool | `false` | Allow overriding existing fixtures                |
| `override_lua_handlers` | bool | `false` | Allow overriding existing Lua handlers            |

An `override_*` capability requires the matching `add_*` to also be enabled — `wraith lint` flags this as `capability-inconsistent`.

---

## scrub.toml

### `[defaults]`

| Field                | Type         | Default  | Description                        |
|----------------------|--------------|----------|------------------------------------|
| `scrub_auth_headers` | bool         | `true`   | Auto-scrub Authorization, Cookie   |
| `scrub_cookies`      | bool         | `true`   | Auto-scrub Set-Cookie values       |
| `tokenize_mode`      | TokenizeMode | `"hmac"` | Default action: `hmac`, `redact`, `mask` |

### `[[rules]]`

User-defined scrub rules are applied in order after built-in rules.

| Field       | Type         | Required | Description                               |
|-------------|--------------|----------|-------------------------------------------|
| `scope`     | ScrubScope   | yes      | `header`, `cookie`, `jsonpath`, `regex`, `query_param` |
| `match`     | string       | yes      | Pattern to match (name, JSONPath, or regex) |
| `action`    | ScrubAction  | yes      | `tokenize`, `mask`, `redact`, or `pseudonymize` |
| `replacement` | string     | no       | Required when action is `mask`            |
| `apply_to`  | ApplyTarget[] | no      | `header_values`, `body`, `query`          |

`pseudonymize` produces a deterministic `user_<base62>` HMAC envelope. Idempotent — re-running scrub on already-pseudonymized values is a no-op. Useful for username-shaped values in URL path segments or response bodies where you want a stable but obfuscated identifier.

### `[pii]`

Default PII detection runs on every recorded body and outbound response (`wraith doctor` audits recordings; `wraith serve` rescrubs outbound bodies). Covers email, phone, SSN, credit card (with Luhn check), name fields (via key-name + cardinality + value-shape heuristics), and git-author blobs (`Bob <bob@example.com>`).

| Field            | Type         | Default      | Description                                                |
|------------------|--------------|--------------|------------------------------------------------------------|
| `detect`         | bool         | `true`       | Master toggle. When `false`, `wraith doctor` skips the PII audit pass entirely (other doctor checks still run). |
| `allowlist`      | string[]     | `[]`         | JSONPath-style glob patterns that bypass PII detection. `*` matches one path segment; leading `$` is anchor-stripped; matching is suffix-based. |
| `default_action` | string       | `"tokenize"` | Action emitted when writing scrubbed PII. `tokenize`, `redact`, or `reject`. **Note**: parsed and stored for round-trip; not yet enforced at scrub-write time. |
| `fields.always`  | string[]     | `[]`         | JSON paths unconditionally treated as PII regardless of cardinality detection. Used when auto-detection misclassifies a real PII field as enum (e.g. a small fixture where every entity has `"Alice"`). |

The detection chain is `fields.always` (forced) → `allowlist` (suppressed) → cardinality-detected `enum_paths` (skipped) → default name-key allowlist → heuristic classification. `allowlist` is the highest-precedence suppression layer.

```toml
[pii]
detect = true
allowlist = [
  "$.country_code",
  "$.timezone",
]

[pii.fields]
always = [
  "$.author.email",
  "$.viewer.name",
]
```

### Built-in Rules

These 11 rules are always active regardless of user configuration:

| Scope        | Pattern                          | Action    |
|--------------|----------------------------------|-----------|
| header       | `authorization`                  | tokenize  |
| header       | `cookie`                         | tokenize  |
| header       | `x-api-key`                      | tokenize  |
| query_param  | `api_key`                        | tokenize  |
| query_param  | `secret`                         | tokenize  |
| query_param  | `password`                       | tokenize  |
| query_param  | `token`                          | tokenize  |
| query_param  | `access_token`                   | tokenize  |
| query_param  | `refresh_token`                  | tokenize  |
| query_param  | `client_secret`                  | tokenize  |
| regex        | `\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b` | redact |

### Example

```toml
[defaults]
scrub_auth_headers = true
scrub_cookies = true
tokenize_mode = "hmac"

[[rules]]
scope = "header"
match = "x-api-key"
action = "tokenize"

[[rules]]
scope = "jsonpath"
match = "$.card.number"
action = "mask"
replacement = "****"

[[rules]]
scope = "jsonpath"
match = "$.card.cvc"
action = "redact"

[[rules]]
scope = "regex"
match = "sk_test_[a-zA-Z0-9]{24}"
action = "tokenize"
apply_to = ["header_values", "body"]
```

---

## drift.toml

Optional. Lives next to `scrub.toml` at `twins/<name>/drift.toml`. Controls how `wraith check` treats drifts that it classifies in the conformance report.

Every divergence emitted by `wraith check` carries a stable `drift_id` (a fingerprint derived from route + path + category + expected/actual values) and a `drift_type` (e.g. `additive_optional_field`, `field_removed`, `status_code_shift`). `drift.toml` lets you suppress or reclassify drifts by glob-matching any of those fields.

Absent file is a silent no-op. Parse or validation errors are logged as warnings and the check continues.

### `[[suppress]]`

Drop divergences that match the rule from the report. Suppressed drifts are counted separately in `drift_suppressed_count`.

| Field        | Type   | Required | Description                                              |
|--------------|--------|----------|----------------------------------------------------------|
| `drift_id`   | string | no       | Match a specific `drift_id` (exact or glob)              |
| `route`      | string | no       | Route pattern (e.g. `"GET /v1/users/*"`)                 |
| `path`       | string | no       | JSON path (e.g. `"body.created_at"`)                     |
| `drift_type` | string | no       | Drift classification (e.g. `"additive_optional_field"`)  |
| `reason`     | string | yes      | Human-readable explanation                               |

At least one matcher field is required in addition to `reason`.

```toml
[[suppress]]
drift_type = "additive_optional_field"
route = "GET /v1/users/*"
reason = "backend adds optional fields on schedule; not worth reclassifying"

[[suppress]]
drift_id = "drift-9f2c4b8e1a3d5f70"
reason = "known harmless field-order change in search responses"
```

### `[[reclassify]]`

Change a drift's `drift_type` without suppressing it. The `drift_id` is recomputed from the new classification.

| Field            | Type   | Required | Description                                  |
|------------------|--------|----------|----------------------------------------------|
| `match`          | table  | yes      | Same matcher fields as `[[suppress]]`        |
| `new_drift_type` | string | yes      | Replacement classification                   |
| `reason`         | string | yes      | Human-readable explanation                   |

```toml
[[reclassify]]
match = { route = "POST /v1/jobs", path = "body.status" }
new_drift_type = "enum_extension"
reason = "upstream adds new enum values often; not a schema break"
```

### Pairing with `[[diff.suppress]]` in `wraith.toml`

`[[diff.suppress]]` (in `wraith.toml`) removes divergences before they are classified as drifts. Use it for divergences that are inherent to your twin (placeholder timestamps, generated IDs) and shouldn't be reported at all.

`[[suppress]]` (in `drift.toml`) keeps divergences in the report but suppresses them at the drift layer. Use it when a drift has been reviewed and accepted, but you still want the raw divergence visible in the JSON output.

---

## Environment Variables

| Variable          | Description                                           |
|-------------------|-------------------------------------------------------|
| `WRAITH_HMAC_KEY` | HMAC key for deterministic tokenisation. Required in CI. |
| `CI`              | When `"true"`, missing HMAC key is a hard error (exit 3). |

### HMAC Key Management

- Set `WRAITH_HMAC_KEY` to any secret string for reproducible tokens across sessions
- Without it, wraith generates an ephemeral key (tokens differ between runs)
- In CI (`CI=true`), a missing key causes exit code 3 (security violation)
- Never commit the key to version control - `wraith doctor` checks for this
