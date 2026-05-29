---
title: Conformance checking and drift handling
description: "Run `wraith check` to compare your twin against its recordings, read the divergence report, score the result, and suppress or reclassify known drifts via `wraith.toml` and `drift.toml`."
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "Check Wraith twin conformance and act on drifts",
  "description": "Run wraith check, read the divergence report, and tune the conformance pipeline via wraith.toml suppressions or drift.toml reclassifications.",
  "step": [
    {"@type": "HowToStep", "name": "Run check", "text": "Run wraith check against the twin in-memory or wire-mode."},
    {"@type": "HowToStep", "name": "Read divergences", "text": "Inspect the report for field-level divergences and per-session scores."},
    {"@type": "HowToStep", "name": "Suppress or reclassify", "text": "Add suppressions for inherent twin behavior; reclassify drifts that need a different category."}
  ]
}
</script>

`wraith check` is the conformance engine. It replays every recorded exchange through the synthesized twin and produces a quantitative measure of how well the twin matches reality — not a string-equality check, but a semantic diff that knows about generated IDs, timestamps, enums, and structural shape.

If the twin scores high enough, you can trust it. If it doesn't, the report tells you exactly which routes are diverging and how.

## In-memory vs wire mode

```sh
wraith check stripe                  # in-memory replay (fast, default)
wraith check stripe --wire           # spawn the real serve and replay through HTTP
wraith check stripe --upstream       # replay against the live upstream API
```

| Mode          | What it tests                                                                | Speed     |
|---------------|------------------------------------------------------------------------------|-----------|
| `--in-memory` | Synth model directly. Skips the HTTP stack, scrub layer, header strip.       | Fast      |
| `--wire`      | Spawns `wraith serve` on a loopback port and replays through reqwest. Catches protocol-level bugs the in-memory check is blind to (header stripping, scrub-layer mismatches, status drift). | Slower    |
| `--upstream`  | Replays the recorded requests against the live API. Detects drift in the upstream itself rather than in the twin. | Network-bound |

In-memory is the default. Use wire-mode in CI when you want to catch the things only a real HTTP stack would surface. Use upstream when you want to know whether the recordings themselves are still valid.

## What "conformance" means

The check engine compares each replayed response field-by-field against the recorded response. Every field is classified before comparison:

| Classification    | Comparison rule                                                       |
|-------------------|-----------------------------------------------------------------------|
| `generated`       | Skipped (different values are fine — UUIDs, etc.)                     |
| `timestamp_like`  | Type-only (both numbers? both strings? compared structurally)         |
| `constant`        | Exact value comparison                                                |
| `enum`            | Value must be in the recorded set                                     |
| `echoed`          | Value must match what was sent in the request                         |
| Default (unclassified) | Exact value comparison                                            |

This classification is automatic — it's what synth produces from observing how each field behaves across recordings. You override it per-field in `wraith.toml`:

```toml
[diff.fields]
"summary.total_value" = { classify = "constant" }
"expires_at" = { classify = "timestamp" }
"theme.color" = { classify = "enum", values = ["dark", "light"] }
```

Hole-style paths — no `body.` prefix; that's added automatically.

## Scoring

Per-exchange scores cover three components: body structure, body values, headers. A session passes when ≥95% of exchanges pass; a run passes when ≥90% of sessions pass. Tune the thresholds:

```toml
[diff]
required_score = 0.90
session_pass_rate = 0.95

[diff.thresholds]
status_exact_match = true
body_structure = 0.90
body_values = 0.85
symbol_consistency = 1.0
header_conformance = 0.80
```

Per-route overrides are available for routes that legitimately need tighter or looser bars:

```toml
[diff.overrides."POST /v1/charges"]
body_structure = 0.95
body_values = 0.95
```

Score format is canonical: every output is `score_bp` (basis points, 0–10000) — `9500` means 95.00%.

## Reading a divergence report

Run `wraith check --format json` to get the structured envelope:

```json
{
  "twin": "stripe",
  "score_bp": 9847,
  "session_pass_rate": 1.0,
  "exchanges_total": 1240,
  "exchanges_passed": 1221,
  "divergences": [
    {
      "route": "POST /v1/charges",
      "session": "session-3",
      "exchange": 17,
      "path": "body.metadata.client_ip",
      "category": "value_mismatch",
      "severity": "error",
      "expected": "10.0.0.1",
      "actual": "192.168.1.1",
      "drift_id": "drift-9f2c4b8e1a3d5f70",
      "drift_type": "value_drift"
    }
  ]
}
```

Each divergence carries:

- **`path`** — JSON pointer to the field that diverged.
- **`category`** — what kind of divergence (`value_mismatch`, `extra_field`, `missing_field`, `array_length_mismatch`, `status_code_mismatch`, etc.).
- **`severity`** — `error`, `warning`, or `info`. Only `error` affects scoring.
- **`drift_id`** — stable fingerprint of (route + path + category + values). Cite it in suppression rules.
- **`drift_type`** — semantic classification of *why* it drifted (`numeric_drift`, `url_drift`, `value_drift`, `host_rewrite`, `enum_expansion`, `additive_optional_field`, `field_removed`, `status_code_shift`).

## Two suppression layers

Wraith separates two kinds of "this divergence is fine":

### `[[diff.suppress]]` in `wraith.toml` — inherent twin behavior

Divergences that are inherent to the synthesized twin and should never have been reported. Suppressed entries are excluded from scoring and from the divergence list (but they're counted, and `--show-suppressed` lists them).

```toml
[[diff.suppress]]
path = "body.created_at"
reason = "twin uses placeholder timestamps"

[[diff.suppress]]
route = "POST /repos/*/statuses/*"
category = "value_mismatch"
reason = "commit status fields are state-dependent"
```

Use when the divergence is something the synth model fundamentally can't replicate (placeholder timestamps, generated IDs in surrogate format, etc.). These aren't drifts — they're inherent.

### `drift.toml` — accepted drifts

Optional file next to `scrub.toml`. Drifts that have been reviewed and accepted as known and harmless, but stay visible in the report:

```toml
[[suppress]]
drift_type = "additive_optional_field"
route = "GET /v1/users/*"
reason = "backend adds optional fields on schedule; not worth reclassifying"

[[suppress]]
drift_id = "drift-9f2c4b8e1a3d5f70"
reason = "known harmless field-order change in search responses"
```

Reclassify drifts that should be a different category without suppressing them:

```toml
[[reclassify]]
match = { route = "POST /v1/jobs", path = "body.status" }
new_drift_type = "enum_extension"
reason = "upstream adds new enum values often; not a schema break"
```

`wraith.toml` suppressions act before drift classification. `drift.toml` acts after. Both are visible to `--show-suppressed`.

## `--show-suppressed`

```sh
wraith check stripe --show-suppressed
```

Lists every suppressed field path with the reason from the rule that suppressed it. Useful when adding a new suppression — confirm it's catching what you intended and not more.

## Action loop

If the check fails:

1. **Read the report.** Find the highest-leverage divergence — one rule often explains many findings.
2. **Decide which suppression layer applies.** Inherent twin behavior → `[[diff.suppress]]`. Known, accepted drift → `drift.toml`.
3. **If neither applies — the twin is wrong.** Either re-record (`wraith record` against the upstream), re-synthesize (`wraith synth`), or run [`wraith generate`](/generate/) to apply LLM-assisted fixes.
4. **Re-run check.** Confirm the score moved.

If the score has plateaued and the remaining divergences are real drift in the upstream itself, the fix is upstream — not in the twin. The twin is doing its job by surfacing the drift.
