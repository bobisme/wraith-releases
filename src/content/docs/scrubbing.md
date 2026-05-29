---
title: Wraith PII and scrubbing pipeline
description: "How Wraith keeps secrets and PII out of recordings, model files, packed archives, and live responses. Covers the 3-layer scrub pipeline, built-in PII detection, `wraith doctor` audits, and how to tune the rules when they catch too much or too little."
---

Wraith's scrub pipeline runs on every byte that hits disk and on every byte sent back to a client. Secrets and PII never reach a recording in cleartext. The default rules cover the common cases out of the box; `wraith.toml` and `scrub.toml` let you tighten or relax them per twin.

The most important property: scrubbing is **deterministic and reversible with a key**. The same secret tokenizes to the same opaque string across recording sessions, so a twin's behavior stays consistent even when its inputs were sensitive. You can later un-tokenize for debugging if you hold the HMAC key.

## The three layers

Every JSON body, header, and query string moves through the same three layers in order:

1. **Built-in rules** (always on). Hardcoded in the binary so a missing or broken `scrub.toml` cannot disable basic protection.
2. **User rules** (from `scrub.toml`). Applied in the order they appear.
3. **HMAC tokenization** (for any rule with `action = "tokenize"`). The matched value is replaced with `wraith_tok_<base62>`, deterministically keyed by the matched scope and value.

After scrubbing, every recorded exchange carries metadata: which rules fired, what the scrub policy hash was, the HMAC key fingerprint, and the keyed digest of the pre-scrub body. The fingerprint lets a recipient verify they're decoding tokens with the right key.

## Built-in rules

These always run and cannot be disabled by `scrub.toml`:

| Scope         | Pattern                                                    | Action   |
|---------------|------------------------------------------------------------|----------|
| `header`      | `authorization`                                            | tokenize |
| `header`      | `cookie`                                                   | tokenize |
| `header`      | `x-api-key`                                                | tokenize |
| `query_param` | `api_key`, `secret`, `password`, `token`, `access_token`, `refresh_token`, `client_secret` | tokenize |
| `regex`       | `\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b` (16-digit card pattern) | redact (replaced with `[REDACTED]`) |

The credit-card regex is paired with a Luhn-check guard inside `wraith doctor`, so authoring fields like 16-digit microsecond timestamps don't spuriously trigger it.

## Default PII pass

In addition to the scrub rules, every recording runs through a PII detection pass. This is keyed on field names and value shapes — independent of explicit rules.

**Field-name detection** (case-insensitive, including suffix patterns):

- Email: `email`, `email_address`, `user_email`, `primary_email`, `contact_email`, and any `*_email` suffix.
- Names: `name`, `full_name`, `first_name`, `last_name`, `given_name`, `family_name`, `display_name`, `username`, `login`, and any `*_name` suffix (`customer_name`, `author_name`).
- Containers whose nested keys are scanned more aggressively: `author`, `committer`, `user`, `owner`, `customer`, `account`, `actor`, `sender`, `recipient`.

**Value-shape detection** (regex on string leaves):

- RFC 5322 email pattern → tokenizes to `user_<base62>@wraith.local`.
- E.164 phone numbers (`+` plus 7–15 digits with optional separators) → tokenizes to `phone_<base62>`.
- US SSN format (`xxx-xx-xxxx`) → tokenizes to `ssn_<base62>`.
- Git author/committer lines (`Name <email> timestamp ±HHMM`) → tokenizes the name as `name_<base62>` and the email as the email envelope above.

The same HMAC key is used as the tokenize action — `bob@example.com` will produce the same token in headers, bodies, and query strings.

### When the default catches too much

Field-name detection is necessarily a heuristic. A field literally called `name` that holds the value `"premium"` is detected as a name and tokenized — usually that's wrong if `"premium"` is a status enum, not a person.

Wraith handles this two ways:

1. **At synthesis time**, low-cardinality high-repetition values get classified as enums and recorded under `RouteModel.enum_paths`. These are skipped by the PII pass at serve time.
2. **At runtime** (serve only — not recording), a built-in allowlist skips well-known enum-shaped key paths like `state.name`, `status.name`, `plan.name`, `tier.name`, `role.name`, `label.name`, `tag.name`, `category.name`, `license.name`, `language.name`.

If neither covers your case, add the field to `[pii] allowlist` in `scrub.toml`:

```toml
[pii]
allowlist = [
  "$.subscription.tier_name",   # not a person's name
  "$.country_code",
]
```

Patterns use JSONPath-style globs: leading `$` is anchor-stripped, `*` matches one path segment, matching is suffix-based.

### When the default catches too little

The opposite problem — auto-detection missed a real PII field. Force it with `[pii.fields].always`:

```toml
[pii.fields]
always = [
  "$.legal_signatory.name",
  "$.viewer.handle",
]
```

`always` is higher precedence than the enum classification and the default allowlist, but lower than the `allowlist` opt-out (so `allowlist` always wins ties).

### Turning off PII detection

For twins where everything looks PII-shaped but isn't (e.g. an internal directory API whose `name` field is a normalized identifier, not a person), disable the default pass entirely:

```toml
[pii]
detect = false
```

User-defined `[[rules]]` still run; only the auto-detection layer is suppressed.

## Scrub actions

A `[[rules]]` entry in `scrub.toml` can take one of four actions:

| Action          | Output                                                          | When to use                                                        |
|-----------------|------------------------------------------------------------------|--------------------------------------------------------------------|
| `tokenize`      | `wraith_tok_<base62>` (deterministic HMAC of the value)         | Default. Stable replacement, reversible if you hold the key.       |
| `mask`          | The literal string you set via `replacement`                    | When you want a recognizable placeholder (`"****"`, `"<redacted>"`). |
| `redact`        | `[REDACTED]`                                                    | Unconditional removal. No reversibility.                           |
| `pseudonymize`  | `user_<base62>` (deterministic HMAC, idempotent)                | Identifying-but-not-secret values (user logins in URL paths).      |

`pseudonymize` is idempotent — running scrub twice on the same value is a no-op. Use it for username-shaped values in URL path segments where you want a stable but obfuscated identifier.

## `wraith doctor` PII audit

```sh
wraith doctor stripe --security-audit
```

`--security-audit` extends doctor's default checks to scan every recording and every model file for PII patterns. Findings are reported with confidence levels and exit code 3 if any high-confidence findings are present without an explicit allow.

Two flags control the audit:

- **`--allow-pii`**. Downgrades PII findings to informational so they don't fail the audit. Use this on twins of public APIs where PII is part of the legitimate response surface (GitHub commit metadata, for example).
- **`--suggest-scrub`**. Prints proposed `scrub.toml` rules for any uncovered secrets at or above `--min-confidence` (default 0.8). Does not modify `scrub.toml` in place — copy-paste the suggestions and review them before adding.

```sh
# Audit a GitHub twin where author metadata is expected.
wraith doctor github --security-audit --allow-pii

# Audit a new twin and get suggestions for tightening scrub rules.
wraith doctor my-api --security-audit --suggest-scrub --min-confidence 0.7
```

## HMAC key

The HMAC key is the secret that makes tokenization deterministic and reversible. Two modes:

- **Set `WRAITH_HMAC_KEY`** in your environment to a stable secret. Tokens are reproducible across runs, machines, and CI.
- **Leave it unset** and wraith generates an ephemeral key per session. Tokens differ between runs.

In CI (`CI=true`), a missing `WRAITH_HMAC_KEY` is a hard error and exits with code 3. This is intentional — without a stable key, recordings made in CI can't be reproduced or audited later.

Store the key in your secrets manager. Never commit it; `wraith doctor` scans tracked files for `WRAITH_HMAC_KEY=` patterns and raises an error if a committed key is found.

The keyed digest of the pre-scrub body is recorded with every exchange. That means: given a recording and the key, you can verify the recording is authentic without needing to un-tokenize it. Given just the recording, you cannot recover the pre-scrub body — the HMAC is one-way.

## Rescrub stages

Scrubbing isn't only at the recording write path. Every distribution boundary re-runs the pipeline:

| Stage             | Why it re-runs                                                                  |
|-------------------|---------------------------------------------------------------------------------|
| `wraith pack`     | Catches PII that slipped through with looser rules at record time               |
| `wraith install`  | Catches PII that slipped through if the archive was packed by an older version  |
| `wraith export`   | OpenAPI / Pact specs include example values; those get rescrubbed before emit   |
| `wraith serve` (outbound) | Live response bodies are rescrubbed before transmission, so the wire never carries PII even if it slipped into the model |

Each stage uses the same envelope guards (`wraith_tok_`, `user_*@wraith.local`, `phone_*`, etc.), so rescrubbing already-scrubbed data is a no-op.

## Reference

For the complete `scrub.toml` field reference, see [Configuration → `scrub.toml`](/configuration/#scrubtoml).
