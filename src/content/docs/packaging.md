---
title: Package, ship, and install Wraith twins
description: "Package a synthesized twin as a portable `.wraith` archive, verify its digests and PII posture, and install it into a fresh workspace. The shipping format for sharing twins between teams or environments."
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "Package and install a Wraith twin",
  "description": "Pack a twin into a portable archive, verify its contents, and install it on another machine.",
  "step": [
    {"@type": "HowToStep", "name": "Pack", "text": "Run wraith pack to bundle the model and configuration into a .wraith archive."},
    {"@type": "HowToStep", "name": "Verify", "text": "Run wraith verify-pack against the archive to check digests and PII posture before distribution."},
    {"@type": "HowToStep", "name": "Install", "text": "Run wraith install to extract and verify the archive into a new twin workspace."}
  ]
}
</script>

A `.wraith` archive is the portable, content-addressed format for shipping a synthesized twin between machines, teams, or environments. Pack a twin in one place, hand the archive to someone else, and they get the same deterministic behavior — with PII rescrubbed on both ends and digests verified before any file lands on disk.

This is the format that overlays travel in too — see [Overlays](/overlays/) for the consumer-side workflow.

## What's in an archive

A `.wraith` archive is a tarball + manifest carrying:

- The synthesized model (`model/symbols.json`, `model/twin.wir.json`).
- `wraith.toml` and `scrub.toml`.
- Optionally, the recordings (`recordings/sessions/`) used to build the model.
- Optionally, build-time diagnostics (compose findings, conformance reports).
- A manifest with per-artifact SHA-256 digests, the wraith version that produced it, scrub-policy hash, and an `artifact_kind` (root twin, overlay, or composite).

Content-addressed: two packs of the same model with the same wraith version produce byte-identical archives.

## `wraith pack`

```sh
wraith pack stripe --output stripe-0.9.0.wraith
```

By default `wraith pack` ships only the model and configuration — recordings stay local. Add flags to include more:

| Flag                    | What it does                                                                 |
|-------------------------|------------------------------------------------------------------------------|
| `--output <path>`       | Where to write the `.wraith` file (required)                                 |
| `--include-recordings`  | Bundle `recordings/sessions/` so the archive can be re-synthed by the recipient |
| `--include-diagnostics` | Bundle compose-phase diagnostics, lint findings, conformance reports under `reports/` |

Every JSON model file is re-scrubbed through the pack pipeline before being sealed (the same scrub layers `wraith record` ran on the way in, applied again as defense-in-depth). The manifest records the scrub policy hash so the recipient can confirm what posture the archive was packed under.

Since v0.17.0 the archive also embeds a human-readable **scrub report** — per-rule match counts, affected field names and routes, the PII-scan verdict, and the scrub-policy hash — covered by the pack's signature. A recipient's security reviewer renders it without unpacking:

```sh
wraith inspect stripe-0.9.0.wraith --scrub-report
```

```sh
# Pack a twin to share with another team, including the source recordings
# so they can re-synth if they want to change synth settings.
wraith pack stripe \
  --output stripe-2026-05-26.wraith \
  --include-recordings \
  --include-diagnostics
```

## `wraith verify-pack`

```sh
wraith verify-pack stripe-0.9.0.wraith
```

Verify the archive without extracting it. Checks:

- The manifest exists and is well-formed.
- Every artifact's recorded digest matches the actual bytes.
- The wraith version that produced the archive is compatible with the version running the check.
- PII findings: any obvious secrets that survived scrub get reported.
- The Ed25519 signature, when the archive is signed and you supply a trust key (`--trust-store <dir>` or `WRAITH_VERIFY_KEY`).

`verify-pack` emits a `VALID`, `WARN`, or `INVALID` verdict on stdout. Pass `--strict` to promote `WARN` to `INVALID` (useful in CI).

The signature line distinguishes four states (since v0.17.0): `signature=ok` (verified), `FAIL` (verification failed), `unverifiable` (the archive **is** signed but you supplied no trust key — a warning advice tells you how), and `unsigned` (no signature at all). Previously a signed-but-unchecked archive was misleadingly labeled `unsigned`.

```sh
# CI gate: only ship the archive if verify-pack is strictly clean.
wraith verify-pack stripe-2026-05-26.wraith --strict --format json
```

## `wraith install`

```sh
wraith install stripe-0.9.0.wraith
```

Extracts the archive into `./twins/<name>/` (or a different directory via `--into`). Before writing any file, install verifies every artifact's digest — a corrupted or tampered archive fails before touching disk.

| Flag             | What it does                                                                 |
|------------------|------------------------------------------------------------------------------|
| `--name <name>`  | Override the twin name from the manifest                                     |
| `--into <dir>`   | Parent directory for the workspace (default: `./twins`)                      |
| `--force`        | Overwrite the target directory if it exists                                  |
| `--no-verify`    | Skip digest verification (not recommended; reserved for offline debugging)   |
| `--rescrub=false` | Skip the install-time defense-in-depth rescrub. Default `true`.             |

The default install-time rescrub catches any PII that slipped through the original pack (e.g. the archive was packed with an older wraith version whose scrub rules have since been tightened). Expected to be a no-op on archives packed by the same wraith version — but it's free insurance against version skew.

```sh
# Install into a custom directory, keep the original name.
wraith install stripe-2026-05-26.wraith --into /opt/wraith/twins/
```

## Shipping workflow

The pattern teams use to hand twins around:

```sh
# Producer side
wraith pack stripe --output stripe.wraith --include-diagnostics
wraith verify-pack stripe.wraith --strict
# Upload stripe.wraith to S3 / GitHub release / artifact registry

# Consumer side
curl -O https://artifacts.example.com/twins/stripe.wraith
wraith verify-pack stripe.wraith --strict
wraith install stripe.wraith
wraith serve stripe
```

For CI pipelines that synthesize on every change:

```sh
# In CI: re-record, synth, verify, pack, publish.
wraith refresh stripe                       # re-record against upstream
wraith synth stripe
wraith check stripe                          # gate on conformance
wraith pack stripe --output stripe.wraith --include-recordings
wraith verify-pack stripe.wraith --strict
# Push stripe.wraith to your artifact store with the commit SHA as a tag.
```

## Determinism notes

`wraith pack` produces byte-identical archives across runs when:

- The input twin workspace is byte-identical.
- The wraith version is the same.
- `SOURCE_DATE_EPOCH` is set (otherwise `created_at` in the manifest uses wall-clock).
- The HMAC scrub key (`WRAITH_HMAC_KEY`) is the same.

This makes archives suitable for content-addressed storage and CI diff workflows: `sha256sum stripe.wraith` is a stable identifier for "this exact twin at this exact moment."
