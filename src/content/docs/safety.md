---
title: Wraith safety surface — doctor, lint, and exit codes
description: "`wraith doctor` and `wraith lint` are the two safety gates that catch missing scrub policies, PII leaks, malformed overlays, and structural problems in your twins. Use them in CI and locally before shipping."
---

Wraith has two complementary safety commands and a structured exit-code contract that makes them CI-friendly.

- **`wraith doctor`** scans recordings and model files for secrets, PII, and configuration problems. Use it after recording, before packing, and in CI.
- **`wraith lint`** checks workspace integrity: schema versions, canonical JSON, model invariants, and overlay configuration. Use it after synth, before serve.

Both default to clean text output and produce structured JSON via `--format json`.

## Exit codes

Wraith uses four exit codes consistently across every command:

| Code | Meaning                              | Examples                                                                 |
|------|--------------------------------------|--------------------------------------------------------------------------|
| `0`  | Success                              | All checks passed.                                                       |
| `1`  | User / configuration error           | Missing argument, invalid config, twin not found.                        |
| `2`  | Conformance threshold not met        | `wraith check` score below `[diff] required_score`.                      |
| `3`  | **Security violation**               | Missing scrub policy, committed HMAC key, high-confidence PII findings.  |
| `4`  | Runtime / infrastructure failure     | Cannot write to disk, panic in dispatch, network error.                  |

Exit code 3 is the one to wire into CI. **A non-zero `wraith doctor` exit means there's a real security issue worth blocking the build over.**

## `wraith doctor`

```sh
wraith doctor stripe
```

Default checks:

- `scrub.toml` exists and parses.
- HMAC key is set (warning if ephemeral; error if committed to the repo).
- `wraith.toml` is well-formed and references valid base URLs.
- Recordings and model files don't carry obvious secrets (the built-in scrub patterns).
- For overlay twins: `[base]` digest is a valid `sha256:<64 hex>`, `[overlay].owner` is non-empty, `[capabilities]` flags are consistent, `[passthrough]` is disabled, and `[overlay].requires` entries are valid artifact references.

Failing checks produce exit code 3 by default.

### `--security-audit`

```sh
wraith doctor stripe --security-audit
```

Extends doctor to scan every recording's body, every header, and every model file for PII patterns. Detects emails, phone numbers, SSNs, credit card numbers (with Luhn check), and git author / committer blobs.

Findings are reported with confidence levels:

- **High-confidence** (RFC-format email, Luhn-passing credit card, SSN-shaped string) → exit 3 by default.
- **Medium-confidence** (name-shaped fields whose values look like real names) → warning, doesn't fail.

### `--allow-pii`

```sh
wraith doctor github --security-audit --allow-pii
```

Downgrades PII findings to informational. Use this on twins of public APIs where PII is part of the legitimate response surface — GitHub commit metadata is the canonical example. PII is still detected and reported, but it doesn't fail the audit.

This is *only* for cases where you've consciously decided PII is allowed. Don't reach for `--allow-pii` to silence findings you haven't looked at.

### `--suggest-scrub`

```sh
wraith doctor stripe --security-audit --suggest-scrub --min-confidence 0.7
```

Prints proposed `scrub.toml` rules for any uncovered secrets at or above the confidence threshold:

```
suggest jsonpath  $.user.api_key                  tokenize  92% high-entropy string in api_key-shaped field
suggest jsonpath  $.results[*].author.email       tokenize  88% RFC5322 email pattern
suggest header    x-internal-token                tokenize  85% header name matches secret-shaped suffix
```

`--suggest-scrub` does **not** modify `scrub.toml` in place — copy-paste the suggestions, review them, and add them deliberately.

## `wraith lint`

```sh
wraith lint stripe
```

Lint focuses on workspace and model integrity:

- **`wraith_toml`** — config parses, required fields present.
- **`scrub_toml`** — scrub config parses.
- **`canonical_json`** — every wraith-authored JSON file is in canonical form (sorted keys, canonical numbers, NFC strings, trailing newline). Catches manual edits that broke determinism.
- **`schema_version`** — model files declare a non-zero schema version.
- **`duplicate-route-id`** / **`duplicate-variant-id`** — route and variant IDs are unique.
- **`missing-artifact-origin`** — every route and variant carries a populated origin (artifact name + digest). Required for overlay provenance.
- **`empty-source-evidence`** — warning, not error. Catches legacy artifacts where the `source_sessions` / `source_exchange_indices` evidence list is empty.

### Overlay invariants (v0.9.0+)

For overlay twins, lint also checks the same configuration invariants `wraith doctor` does:

- `base-digest-invalid` — `[base].digest` doesn't match the `sha256:<64 hex>` shape.
- `overlay-owner-missing` — `[overlay].owner` is empty.
- `capability-inconsistent` — an `override_*` capability flag is true without the matching `add_*` flag.
- `passthrough-disallowed` — overlay twin has `[passthrough].enabled = true`.
- `overlay-requires-invalid` — entry in `[overlay].requires` isn't a valid `name@sha256:<64 hex>` reference.

Before v0.9.0 these checks lived only in `wraith doctor`. The lint surface closes the split-brain — CI that gates on `wraith lint --format json` no longer silently misses overlay misconfiguration.

## When each command runs in CI

A typical CI pipeline runs both:

```sh
#!/usr/bin/env bash
set -euo pipefail

# After recording, before synth: confirm there's no PII in what we captured.
wraith doctor stripe --security-audit --format json > doctor.json

# After synth, before serve / pack: confirm the model is well-formed.
wraith lint stripe --format json > lint.json

# Now the conformance gate.
wraith check stripe --format json > check.json
SCORE=$(jq '.score_bp' check.json)
if [ "$SCORE" -lt 9500 ]; then
  echo "twin conformance below threshold: $SCORE" >&2
  exit 2
fi

# Pack and verify the archive before shipping.
wraith pack stripe --output stripe.wraith --include-recordings
wraith verify-pack stripe.wraith --strict --format json > verify.json
```

If any of those steps exit non-zero, the build fails on a specific code: 3 for security violations, 2 for conformance, 1 for user error, 4 for infrastructure problems. Distinct codes mean your CI dashboard can show "failing on security" vs "failing on conformance" without parsing the output.

## Recommended posture

- **Run `wraith doctor` after every record session locally.** It's fast, and catching a PII leak before it lands in CI is a much cheaper conversation.
- **Run `wraith doctor --security-audit` in CI for every twin.** Use `--allow-pii` only when the API legitimately serves PII and you've explicitly chosen to record it.
- **Run `wraith lint` after every synth.** It catches the structural problems `wraith check` doesn't — broken canonical JSON, missing schema versions, malformed overlay configuration.
- **Treat exit code 3 as a hard fail.** Don't `|| true` around it. If `wraith doctor` is wrong about a finding, fix the finding (with `--allow-pii`, a `[pii] allowlist` entry, or a real scrub rule) rather than silencing the gate.

The exit-code contract exists so the safety surface composes with whatever orchestrator you run. Don't disable it — tune it.
