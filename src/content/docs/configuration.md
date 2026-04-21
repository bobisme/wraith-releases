---
title: Configuration Reference
description: All wraith.toml and scrub.toml settings
---

Wraith uses two TOML files per twin workspace to control behaviour and security policy.

## File Locations

```
twins/<name>/
├── wraith.toml    # Twin behaviour, thresholds, generation settings
└── scrub.toml     # Security scrubbing rules
```

Both are created automatically by `wraith init`.

---

## wraith.toml

### `[service]` (required)

| Field      | Type   | Default | Description                                  |
|------------|--------|---------|----------------------------------------------|
| `name`     | string | --       | Twin name (directory name under `twins/`)    |
| `base_url` | string | --       | Upstream API base URL                        |
| `spec`     | string | --       | Optional path to OpenAPI spec                |

### `[proxy]`

| Field  | Type   | Default     | Description                        |
|--------|--------|-------------|------------------------------------|
| `mode` | string | `"reverse"` | Proxy mode: `reverse` or `forward` |
| `port` | u16    | `8080`      | Port the recording proxy binds to  |

### `[serve]`

| Field              | Type   | Default    | Description                                      |
|--------------------|--------|------------|--------------------------------------------------|
| `port`             | u16    | `8081`     | Port the twin server binds to                    |
| `session_mode`     | string | `"header"` | Session isolation: `header`, `cookie`, or `path` |
| `fidelity`         | string | `"synth"`  | Response mode: `strict` or `synth` (`permissive` is reserved, not yet implemented) |
| `deterministic_seed` | u64  | `42`       | Seed for deterministic random generation         |
| `debug`            | bool   | `false`    | Enable debug response headers                    |

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

Override field classifications for specific JSON paths. Use hole-style paths (no `body.` prefix -- it's added automatically).

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

| Field                      | Type   | Default    | Description                             |
|----------------------------|--------|------------|-----------------------------------------|
| `min_exchanges_per_route`  | u32    | `3`        | Min exchanges before pattern extraction |
| `low_confidence_threshold` | f64    | `0.20`     | Below this, route is flagged low-conf   |
| `array_mode`               | string | `"schema"` | `schema` or `element`                   |

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
| `default_runner` | string?  | --       | Default LLM runner name              |
| `fallback`       | string[] | `[]`    | Fallback runner chain                |
| `air_gapped`     | bool     | `false` | Disable all network-based runners    |

### `[generate.runners.<name>]`

| Field     | Type     | Default | Description                     |
|-----------|----------|---------|---------------------------------|
| `command` | string   | --       | Runner executable               |
| `args`    | string[] | `[]`    | Command-line arguments          |
| `format`  | string?  | --       | Output format (`json`, etc.)    |

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
| `action`    | ScrubAction  | yes      | `tokenize`, `mask`, or `redact`           |
| `replacement` | string     | no       | Required when action is `mask`            |
| `apply_to`  | ApplyTarget[] | no      | `header_values`, `body`, `query`          |

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

## Environment Variables

| Variable          | Description                                           |
|-------------------|-------------------------------------------------------|
| `WRAITH_HMAC_KEY` | HMAC key for deterministic tokenisation. Required in CI. |
| `CI`              | When `"true"`, missing HMAC key is a hard error (exit 3). |

### HMAC Key Management

- Set `WRAITH_HMAC_KEY` to any secret string for reproducible tokens across sessions
- Without it, wraith generates an ephemeral key (tokens differ between runs)
- In CI (`CI=true`), a missing key causes exit code 3 (security violation)
- Never commit the key to version control -- `wraith doctor` checks for this
