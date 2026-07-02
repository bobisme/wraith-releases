---
title: Wraith intent contracts — consumer-driven API twin verification
description: "Package a consumer's API expectations as a signed .wic contract that pins the twin by digest and carries runnable scenarios, then verify it against a freshly composed twin in CI. Covers packing, the provider trust gate, the lifecycle and status model, and CI gating."
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "Verify a Wraith intent contract against a twin",
  "description": "Author scenarios into a signed .wic contract, inspect it, verify it against a freshly composed twin, accept it through the provider trust gate, and choose how it gates CI.",
  "step": [
    {"@type": "HowToStep", "name": "Pack", "text": "Assemble a deterministic, signed .wic from staged scenarios."},
    {"@type": "HowToStep", "name": "Inspect", "text": "Summarize the package and run the strict trust-gate lint."},
    {"@type": "HowToStep", "name": "Verify", "text": "Compose and serve the twin, run the scenarios through sigil, and report a CI envelope."},
    {"@type": "HowToStep", "name": "Accept", "text": "Check the signature against trusted keys and record the decision in a sidecar."},
    {"@type": "HowToStep", "name": "Gate", "text": "Set the provider status dial: advisory, accepted, or blocking."}
  ]
}
</script>

An **intent contract** is a consumer team's executable statement of what they depend on from a provider's API, packaged as a signed `.wic` archive. It pins the base (and any overlay) twin by digest, carries runnable [sigil](/lua/) Lua scenarios plus the canonical `lib/wraith.lua` helper, and is verified against a freshly composed twin — so a provider can see, in CI, exactly which downstream expectations a change would break, before shipping it.

Intent contracts shipped in v0.10.0. They are **purely additive**: every v0.9.x pack, composite, and `wraith.toml` re-verifies and re-serves unchanged, and root and overlay twins are untouched. The entire surface is the `wraith contract` command group.

## When to use a contract

- **You consume an API and want breakage caught upstream.** Instead of finding out in production that a provider changed a field you parse, hand the provider a contract: their CI runs your scenarios against their twin and fails the build if your expectation breaks.
- **A provider wants to know who depends on what.** Accepted contracts under `contracts/<consumer>/` are a living, machine-readable map of downstream expectations — each with a gating decision the provider controls.
- **You need verification without sharing recordings.** The default evidence mode is `reference_only`: the contract carries scenarios and digests, not your captured traffic. Scrubbed-excerpt and full-recording modes exist but must be admitted explicitly at accept time.

## Author a contract

You don't have to write scenarios by hand. The fastest path is to **generate** one from a twin you've already recorded (added in v0.15.0):

```sh
wraith contract propose billing --out ./staged \
  --consumer checkout-service --provider billing-api --owner checkout-team \
  --base billing-api@sha256:… --overlay checkout-billing@sha256:…
```

`propose` reads the twin's recordings and writes a staged contract directory — one scenario per distinct workflow it sees across your sessions, with the request flow and any inferred value round-trips (an id created in one call and reused in the next, a field echoed back) turned into checks. The inferred checks are **advisory** (`sigil.check`): they record pass/fail but never fail a run. Review them, promote the ones you mean to enforce to `expect()`, then pack. Restrict the evidence with `--tag` or `--from-session`, and the output is byte-identical run to run.

Prefer to write scenarios yourself? Scaffold an empty skeleton instead:

```sh
wraith contract scaffold ./staged \
  --consumer checkout-service --provider billing-api --owner checkout-team \
  --base billing-api@sha256:… --overlay checkout-billing@sha256:…
```

That writes a ready-to-edit staged directory — the manifest, the pinned `lib/wraith.lua` helper, and one placeholder scenario to fill in. (`wraith contract helper` emits or verifies that helper on its own.) Either path leaves you with a staged directory ready to pack.

## The `.wic` package

A `.wic` is a deterministic, Ed25519-signed tar archive. Packing the same staged directory twice produces byte-identical output; unpacking verifies the content-tree digest and the signature against the embedded key.

```sh
# Once you have a staged dir (from propose or scaffold), pack a signed contract:
wraith contract pack ./staged --output checkout-refund.wic --key ./signing.key

# Inspect what's inside; --strict runs the trust-gate lint:
wraith contract inspect checkout-refund.wic --strict
```

Pack runs a PII scan over the whole bundle before sealing it. A sensitive literal aborts the pack (`exit 3`) and names the offending file; admit it knowingly with `--override-pii <reason>`, which is recorded in the manifest so the provider's accept gate sees the decision.

## Set up trust: keys, signing, and the policy allowlist

`verify` composes the base + overlay twins under the default compose policy, which requires **signed** twin packs and an **allowlisted** scrub policy. These are hard security gates (`--no-strict` does not relax them), so a real overlay needs three one-time setup steps before `verify` goes green:

1. **A keypair.** `wraith key gen` prints a base64 secret (for signing) and the matching public key (for the trust store). Persist both.
   ```sh
   wraith key gen --format json   # -> { key: { secret_b64, public_b64, key_id } }
   ```
2. **Signed packs with a reproducible digest.** Sign the base and overlay packs that `verify` will compose. Set a persistent `WRAITH_HMAC_KEY` **first** — without it each `pack` generates an ephemeral key, so the content digest changes every run and the contract's pinned `[base].digest` goes stale.
   ```sh
   export WRAITH_HMAC_KEY=<persisted base64>      # reproducible content digests
   wraith pack billing           --output base.wraith --key <secret_b64>
   wraith pack checkout-billing  --output ov.wraith   --key <secret_b64>
   ```
3. **Allowlist the overlay's scrub policy.** If the overlay ships its own scrub rules, list its policy hash so the compose gate admits it. (An overlay that inherits the base's `scrub.toml` **unchanged** is admitted automatically — no entry needed.)
   ```sh
   # the hash is exposed in the pack envelope:
   wraith pack checkout-billing --output ov.wraith --format json | jq -r .pack.base.scrub_policy_hash
   ```
   ```toml
   # .wraith/overlay-policy.toml
   [overlay_policy]
   allowed_scrub_policy_hashes = ["sha256:…"]
   ```
   The policy file has a published schema — `wraith schema` emits `overlay-policy.schema.json` for editor validation.

## Verify against your own twin

`verify` is the heart of the loop. It resolves the manifest's pinned artifacts to your local packs, composes and serves the twin, runs the contract's scenarios through `sigil`, and reports a CI-ready envelope.

```sh
wraith contract verify checkout-refund.wic \
  --base-pack base.wraith \
  --overlay-pack ov.wraith \
  --overlay-policy .wraith/overlay-policy.toml \
  --format json
```

`--overlay-policy <file>` hands the compose step your trust policy (the `allowed_scrub_policy_hashes` from the setup above) — since v0.17.0, `--policy` works as an alias, matching `wraith compose --policy`; omit it and `verify` auto-discovers `<base>/.wraith/overlay-policy.toml` when the base pack carries one. `--pack-dir <dir>` auto-resolves the pinned base and overlay artifacts by digest, so you can point at a directory of `.wraith` packs instead of naming each one; a pin that no flag or directory satisfies is a resolution error that names the exact digest it needs. When compose rejects the composition, `verify` (and `rebase-check`) now surface the underlying finding — e.g. `base-digest-mismatch` with both digests, or `scrub-policy-not-allowlisted` — instead of a generic failure.

### Exit codes

- **`0`** — every scenario passed.
- **`1`** — user error (missing pack, unresolved pin, bad input).
- **`2`** — a contract scenario failed (an expectation diverged).
- **`3`** — digest or signature mismatch, or another trust-gate rejection.
- **`4`** — runtime error standing up or exercising the twin.

## Accept through the trust gate

Verifying proves a contract passes against a twin; **accepting** is the provider's decision to install it. Accept checks the signature against keys you trust, applies the admission policy, materializes the contract's runnable scenarios, and seeds a `<name>.status.toml` sidecar you commit alongside your code.

```sh
wraith contract accept checkout-refund.wic --trust-store ./trusted-signers
```

The trust gate is strict by default. Non-`reference_only` evidence modes, capabilities outside `{http, wraith}`, extra helper modules, and non-self-contained packages each require an explicit `--allow-…` flag, and every admitted exception is recorded in the sidecar for audit. Re-accepting a contract that already has a decision is **refused** unless you pass `--force` — so a no-flag re-accept can never silently revert a `reject` or `suspend` back to installed.

## The lifecycle and status model

A contract carries three independent dials so the consumer's intent, each scenario's maturity, and the provider's gating decision never collide:

- **consumer_status** (in the signed `.wic`) — `observed`, `proposed`, or `deprecated`. The consumer's claim about the expectation.
- **scenario lifecycle_state** — `draft` → `canary` → `active` → `quarantined` → `retired`. How mature each scenario is. Moved with `promote` / `demote` / `quarantine` / `retire`.
- **provider_status** (in the unsigned sidecar) — the gating dial the provider owns.

The provider dial has three installed positions plus two "not installed" decisions:

| status      | effect on CI                                        |
|-------------|-----------------------------------------------------|
| `advisory`  | scenarios run, but never fail the build (accept default) |
| `accepted`  | a violation **warns**                               |
| `blocking`  | a violation is a **hard CI failure**                |
| `rejected`  | declined — not installed                            |
| `quarantined` | held for cooldown — not installed                 |

```sh
wraith contract set-status blocking --consumer checkout-service --name checkout-refund
wraith contract reject  --consumer checkout-service --name checkout-refund --reason "out of scope"
wraith contract suspend --consumer checkout-service --name checkout-refund --reason "cooldown"
```

The sidecar keeps an honest audit trail: `accepted_by` is the **original** accepter (set once and preserved), while `decided_by` names whoever made the **latest** decision — so a rejected contract shows both who first accepted it and who rejected it, and why.

## Read back where things stand

```sh
# One contract's package status + per-scenario lifecycle:
wraith contract status --consumer checkout-service --name checkout-refund

# Every installed contract under a provider root (add --status all to include declined):
wraith contract list --status all
```

Both verbs default to the installed view; `list` hides `rejected` and `quarantined` contracts unless you ask for them.

## Check a contract against a base bump

When the provider re-records and the base digest advances, `wraith contract rebase-check` classifies each contract against the new base — `compatible`, `additive-safe`, or `conflict`, with confidence and evidence — so you can tell whether a base change breaks a downstream expectation without re-recording anything.

## Full workflow

```sh
# One-time: a signing keypair
wraith key gen --format json   # persist secret_b64 (sign) + public_b64 (trust store)

# Consumer: generate from recordings (or scaffold by hand), pack, share
wraith contract propose billing --out ./staged \
  --consumer checkout-service --provider billing-api --owner checkout-team \
  --base billing-api@sha256:abc --overlay checkout-billing@sha256:def
wraith contract pack ./staged --output checkout-refund.wic --key ./signing.key
wraith contract inspect checkout-refund.wic --strict

# Provider: sign the twin packs (persistent WRAITH_HMAC_KEY -> stable digests),
# allowlist the overlay's scrub policy, then verify in CI and accept
export WRAITH_HMAC_KEY=<persisted base64>
wraith pack billing          --output base.wraith --key <secret_b64>
wraith pack checkout-billing --output ov.wraith   --key <secret_b64>
wraith contract verify checkout-refund.wic \
  --base-pack base.wraith --overlay-pack ov.wraith \
  --overlay-policy .wraith/overlay-policy.toml --format json
wraith contract accept checkout-refund.wic --trust-store ./trusted-signers
wraith contract set-status blocking --consumer checkout-service --name checkout-refund

# Later, when the base advances:
wraith contract rebase-check --consumer checkout-service --name checkout-refund \
  --new-base billing-api@sha256:def
```

## v0.10.0 scope

What's **in**:

- Signed, deterministic `.wic` packages with digest-pinned twins and an embedded helper.
- A pre-archive PII scanner with explicit override.
- `verify` against composed twins via `sigil`, with structured exit codes and a CI envelope.
- A strict provider trust gate (`accept`) with per-exception admission flags.
- The full three-axis lifecycle and status model, with a set-once acceptance audit trail.
- `rebase-check` classification against a new base.

What's **deferred**:

- Evidence caching for repeated verifies.
- Non-REST/GraphQL protocol scenarios (SOAP, JSON-RPC) beyond the existing twin support.

See the [changelog](/changelog/) v0.10.0 entry for the complete shipping list, and the in-repo `docs/contracts-provider-ci.md` for CI integration modes.
