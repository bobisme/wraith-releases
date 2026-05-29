---
title: Wraith overlays — layered API twin extensions
description: "Layer workflow-specific behavior onto a provider-owned base API twin without forking the base. Cover the digest-pinned base config, the materialized compose engine, fixture selection, rebase-check, and the v0 additive-only scope."
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "Layer a Wraith overlay onto a base twin",
  "description": "Initialize an overlay against a digest-pinned base twin, record consumer-specific behavior, synthesize the delta, compose into a materialized composite, and serve it.",
  "step": [
    {"@type": "HowToStep", "name": "Init", "text": "Create an overlay twin with a digest-pinned base reference."},
    {"@type": "HowToStep", "name": "Record", "text": "Capture consumer-specific traffic through the local proxy."},
    {"@type": "HowToStep", "name": "Synth --delta", "text": "Synthesize only routes that diverge from the base."},
    {"@type": "HowToStep", "name": "Compose", "text": "Materialize a composite twin from the base plus one or more overlays."},
    {"@type": "HowToStep", "name": "Serve", "text": "Run the composite locally with the standard serve command."},
    {"@type": "HowToStep", "name": "Rebase-check", "text": "When the base advances, classify the overlay's compatibility against the new digest."}
  ]
}
</script>

Overlays let a consumer team layer workflow-specific behavior onto a provider-owned base twin **without forking the base**. The core invariant: an overlay is a normal Wraith twin with a digest-pinned base reference, packaged as a `.wraith` artifact, policy-checked, and composed into a materialized composite twin before serving.

Overlays shipped in v0.9.0. v0 is **additive-only** — overlays may add routes, add disjoint variants on existing routes, extend schema, add fixture sets, add fault profiles, and contribute evidence recordings. v0 rejects base-route deletion, base-variant mutation, Lua handler shadowing, and changes to base scrub or passthrough posture. A twin without `[base]` in its `wraith.toml` is a "root" twin and serves exactly as it did pre-v0.9.0 — overlay code paths are inert.

## When to use an overlay

- **A consumer needs a behavior the provider hasn't recorded.** Stripe doesn't ship a webhook replay scenario for your checkout error path, but you need one in CI. Record that scenario locally, synthesize it as an overlay, and the next time the provider re-records its base twin you don't lose your work.
- **A test environment needs different fixture data than the base.** The base twin ships canonical customer / charge fixtures. Your overlay seeds the demo dataset your team uses, without leaking it back into the base.
- **A team needs to add fault-injection or latency profiles for their CI runs** without changing the shared twin.

If you'd otherwise vendor a copy of the provider's twin and edit it, you want an overlay.

## The `[base]` config

A twin becomes an overlay when its `wraith.toml` carries a `[base]` section:

```toml
[base]
artifact             = "billing-api"
digest               = "sha256:abc123…"        # digest-pinned reference
model_schema_version = 1
scrub_policy_hash    = "sha256:def456…"

[overlay]
owner       = "checkout-team"                  # provenance hint
description = "Checkout-specific billing overrides"
requires    = ["checkout-shared@sha256:…"]     # optional declared deps
```

`wraith init <name> --base <ref> --owner <team>` writes the section for you.

## The compose engine

**Composition is materialized, not runtime-only.** `wraith compose --base <base.wraith> --overlay <ovl.wraith> --output <composite>` merges the base plus any number of overlays into a standard twin workspace (or `.wraith` archive), in CLI argument order. The composite is then served, checked, packed, or installed exactly like any other twin.

Compose is deterministic — composing the same inputs twice yields byte-identical artifacts. Canonical JSON, sorted route and variant emission, no wall-clock leakage.

### Conflict detection is sound but incomplete

Variants on a shared route must be **provably disjoint** by construction:

- Mutually exclusive literal equalities (`status == 200` vs `status == 404`)
- Non-overlapping numeric ranges (`amount < 100` vs `amount >= 100`)
- `exists` vs `not_exists` on the same field

Anything else is flagged as a conflict in strict mode (`exit 2`). The disjointness checker is sound — it never accepts a real overlap — but it is intentionally conservative, so two variants that happen to be disjoint via SMT-level reasoning may still be rejected.

### Exit codes

- **`0`** — overlay composes cleanly.
- **`1`** — user error (bad config, missing artifact).
- **`2`** — conformance threshold not met OR disjointness checker rejected a variant overlap.
- **`3`** — policy-disallowed capability (e.g. weaker scrub posture, base-route deletion, Lua shadowing). JSON findings emitted with `{path, capability, reason, severity}`.
- **`4`** — runtime error during composition.

## Fixture selection

Overlay-contributed fixtures load into per-namespace state under the same `state/fixtures/<entity_type>.json` shape used by base twins (v0.8.3). The default namespace is **never** auto-seeded with overlay fixtures — operators opt in by sending an `X-Wraith-Fixture: <overlay-name>` header or by passing `wraith serve --fixture <overlay-name>` so demos remain reproducible. Without selection, overlay-contributed entities are silently absent from `state.query()`.

## Rebase-check

When the upstream provider re-records and the base digest advances, you don't need to re-record your overlay's traffic to know whether it's still compatible. `wraith rebase-check --overlay <ovl.wraith> --new-base <base@sha256:…>` re-runs the overlay's policy and compose validation against the newer base and emits a classification with confidence and evidence:

- **`compatible`** — no behavior change. Overlay's contributed surface is unchanged by the base bump.
- **`additive-safe`** — base added new routes or variants but the overlay's contributions remain disjoint. Safe to ship.
- **`conflict`** — newly-overlapping guards, deleted base routes, or scrub posture change. Re-record or revise required.

Used by consumers to decide whether to promote an overlay against a base bump without re-recording.

## Promotion

`wraith promote --overlay <ovl.wraith>` is the gated publication step — requires policy pass plus evidence sufficiency. Evidence-light overlays may be `wraith check`'d but not promoted, so an overlay can't ship behavior it hasn't demonstrated against the base.

## Full workflow

```sh
wraith init checkout-billing --base billing-api@sha256:abc --owner checkout
wraith record checkout-billing --tag happy-path
wraith synth checkout-billing                              # --delta is default for overlays
wraith compose --base billing-api.wraith \
               --overlay checkout-billing.wraith \
               --output composite
wraith serve composite

# Later, when the provider re-records the base:
wraith rebase-check --overlay checkout-billing.wraith \
                    --new-base billing-api@sha256:def
```

`wraith synth` on an overlay defaults to `--delta` (record only what diverges from the base). Pass `--full` to synth the entire twin, or `--base-path <path>` to point at a base artifact for delta comparison. After `synth --delta`, `<twin-root>/build/delta-report.json` carries the per-route delta breakdown plus structured advice (`overlay-is-redundant`, `many-unreplayable`, `base-route-missing`).

## v0 scope and limitations

What's **in** for v0.9.0:

- Add routes, add disjoint variants on existing routes, extend schema.
- Add fixture sets and fault profiles.
- Contribute evidence recordings.
- Deterministic compose with byte-identical re-runs.
- Materialized composites that serve, check, pack, and install like any other twin.
- Rebase-check classification with confidence and evidence.

What's **deferred**:

- Base-route deletion and base-variant mutation.
- Lua handler shadowing across the base / overlay boundary.
- OCI registry push and pull (overlays still travel as `.wraith` archives).
- Suggested-patch promote artifact (`wraith promote` gates correctly but does not yet emit the suggested-patch document).

See the [changelog](/changelog/) v0.9.0 entry for the complete shipping list.
