---
title: LLM-assisted twin repair with `wraith generate`
description: "Run an LLM repair loop over routes that the inference engine couldn't get to passing conformance. Covers providers, budgets, agentic vs single-shot mode, audit files, exhaustion reasons, and the `--interactive` review flow."
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "Repair a Wraith twin with an LLM",
  "description": "Run wraith generate against routes that wraith synth and wraith check could not get to passing conformance.",
  "step": [
    {"@type": "HowToStep", "name": "Check first", "text": "Run wraith check to see which routes are failing and by how much."},
    {"@type": "HowToStep", "name": "Run generate", "text": "Run wraith generate with a budget and a provider; it iterates on the lowest-scoring routes."},
    {"@type": "HowToStep", "name": "Review", "text": "Inspect the audit file or run with --interactive to approve patches before they're applied."}
  ]
}
</script>

`wraith generate` is the optimization loop you run when `wraith synth` and `wraith check` have done their job but conformance still isn't high enough. It picks the lowest-scoring routes, asks an LLM what to change, applies the proposed patches if they actually improve the score, and writes a full audit trail.

It's not a substitute for synth — synth is deterministic and handles the bulk of route inference. Generate is for the long tail: routes whose response shape depends on subtle conditions the inference engine can't infer from observations alone.

## Quick start

```sh
wraith check stripe          # see what's failing
wraith generate stripe       # run the repair loop
wraith check stripe          # confirm the score improved
```

Default budgets are conservative (10 routes, 1M tokens, 30 minutes). For CI runs, set them explicitly:

```sh
wraith generate stripe \
  --max-iterations 5 \
  --token-budget 200000 \
  --time-budget 600 \
  --provider ollama \
  --model qwen3.5:9b \
  --format json
```

## Flags

| Flag                  | What it does                                                                       |
|-----------------------|------------------------------------------------------------------------------------|
| `--max-iterations N`  | Process at most N routes. Default 10.                                              |
| `--token-budget N`    | Cap total tokens across all LLM calls. Default 1,000,000.                          |
| `--time-budget SECS`  | Hard wall-clock limit. Default 30 minutes. Cancels in-flight calls — not advisory. |
| `--provider NAME`     | Override `[generate.routing] default_runner` from `wraith.toml`.                   |
| `--model NAME`        | Override the model for the chosen provider.                                        |
| `--air-gapped`        | Reject any non-local provider. Local-only LLM runners pass.                        |
| `--agentic`           | Force agentic (multi-turn tool-use) mode for every route.                          |
| `--no-agentic`        | Force single-shot mode for every route.                                            |
| `--rounds N`          | Re-synth and re-run until the score plateaus, up to N rounds. Default 1.           |
| `--interactive`       | Prompt before applying each patch.                                                 |
| `--explain`           | Print rationale for each proposed change.                                          |
| `--format json`       | Structured output envelope.                                                        |

## Agentic vs single-shot

Two modes, automatically selected per route by default:

- **Single-shot.** The LLM receives the route, its divergences, and a sample of exchanges. It returns one proposed patch. Fast and cheap. Used for routes with five or fewer divergences.
- **Agentic.** The LLM operates a route-level sandbox via twelve tools (`inspect_route`, `inspect_divergences`, `inspect_samples`, `update_field`, `add_field`, `remove_field`, `set_status`, `set_header`, `create_variant`, `update_hole`, `check`, `done`). It iterates up to 15 turns or until it calls `done`. Used for complex routes.

Override the automatic choice with `--agentic` (force agentic everywhere) or `--no-agentic` (force single-shot). Agentic mode produces a transcript suitable for fine-tuning; single-shot is cheaper and faster.

## Providers

Providers are declared in `wraith.toml`:

```toml
[generate.routing]
default_runner = "claude"
fallback       = ["ollama"]
air_gapped     = false

[generate.runners.claude]
command = "claude"
args    = ["-m", "claude-opus-4-7", "--format", "json"]
format  = "json"

[generate.runners.ollama]
command = "ollama"
args    = ["run", "qwen2.5:7b"]
format  = "text"

[generate.runners.openai]
command = "openai"           # or any shell-callable wrapper
args    = ["chat", "--model", "gpt-4"]
format  = "json"
```

Every provider is reached through a shell command. There are no SDK integrations — the provider runs as a subprocess and you talk to it on stdin/stdout. This is intentional: any LLM with a shell wrapper works, including local ones (`ollama`, `llama.cpp`), commercial APIs (`openai`, `claude`, `openrouter`), and your own scripts.

`--air-gapped` rejects providers whose `command` is known to require network access. Local providers pass.

## Budgets are enforced

Both `--time-budget` and `--token-budget` are hard limits, not advisory:

- **Time.** Each LLM call is wrapped against the run-level deadline. If the deadline expires during an in-flight HTTP call, the call is cancelled and the run exits within the budget plus ~5 seconds of grace.
- **Tokens.** Each call's completion is capped at `min(8192, tokens_remaining)`. The prompt is also accounted — `estimate_prompt_tokens` (chars/4 heuristic) subtracts from the budget before `max_tokens` is computed. When the prompt alone would exceed the remaining budget, the call is skipped with rejection reason `budget-exhausted`.

This matters in CI. A stalled provider or a runaway agentic loop won't burn the rest of your build job.

## Audit files

Every run writes `twins/<name>/reports/generate-audit/generate-audit-<ts>-<run_id>.json`:

```json
{
  "start_timestamp": "2026-05-26T12:00:00Z",
  "end_timestamp": "2026-05-26T12:14:32Z",
  "twin": "stripe",
  "run_id": "abc123",
  "provider": "ollama",
  "model": "qwen2.5:7b",
  "agentic_mode": "auto",
  "budgets": {
    "max_iterations": 10,
    "token_budget": 1000000,
    "time_budget_seconds": 1800
  },
  "initial_conformance": { "score_bp": 8500, "divergence_count": 42 },
  "final_conformance":   { "score_bp": 9200, "divergence_count": 18 },
  "tokens_used": 234567,
  "exhaustion_reason": "completed",
  "patches": [ … ],
  "rounds":  [ … ]
}
```

The file is written atomically at start and rewritten after every patch, every round, on success, on error, and on panic. A SIGKILL leaves `"exhaustion_reason": "started"` on disk — your CI can distinguish "still running" from "completed cleanly" without having to scrape logs.

## Exhaustion reasons

The terminal state of a run. Precedence order, highest first:

1. `error` — runtime failure.
2. `panic` — internal panic.
3. `killed` — external signal (SIGTERM / SIGINT).
4. `time_exhausted` — `--time-budget` fired.
5. `budget_exhausted` — `--token-budget` fired.
6. `iterations_exhausted` — `--max-iterations` fired.
7. `completed` — all work finished.
8. `started` — process didn't make it to a clean exit (initial state; survives SIGKILL).

If your CI gates on conformance, treat anything other than `completed` as a hard fail.

## Rejection reasons

Each rejected patch carries one of:

| Reason                | Meaning                                                                        |
|-----------------------|--------------------------------------------------------------------------------|
| `budget-exhausted`    | Budget ran out before the LLM produced a usable patch.                         |
| `parse-failure`       | LLM response couldn't be parsed.                                               |
| `regression-rejected` | Patch made conformance worse (route-level OR global divergence count went up). |
| `empty-edits`         | LLM finished without proposing any change.                                     |
| `protocol-failure`    | LLM didn't follow the tool-use protocol (agentic mode).                        |
| `llm-error`           | Provider returned a network or API error.                                      |
| `user-declined`       | `--interactive` mode and the user said no.                                     |

`regression-rejected` is the one worth watching: it means the LLM proposed a change that made things worse, and wraith rolled it back. Repeated regressions on the same route usually indicate the model needs a clearer prompt or a richer set of recordings.

## Interactive mode

```sh
wraith generate stripe --interactive
```

Before each accepted patch, prints a unified diff of `{status, headers, template}` to stderr and prompts:

```
apply this patch? [y/N]:
```

`y` or `yes` (case-insensitive) accepts. Anything else — including EOF — rejects with `rejection_reason: user-declined`. The stdout JSON envelope stays clean, so `--format json` and `--interactive` compose.

Use interactive when you're shaping the prompt or evaluating a new provider. For CI, leave it off and gate on the audit file.

## CI integration

```sh
#!/usr/bin/env bash
set -euo pipefail

wraith check stripe --format json > before.json
SCORE_BEFORE=$(jq '.score_bp' before.json)

if [ "$SCORE_BEFORE" -lt 9500 ]; then
  wraith generate stripe \
    --time-budget 600 \
    --token-budget 200000 \
    --max-iterations 5 \
    --provider ollama \
    --format json > generate.json

  REASON=$(jq -r '.result.exhaustion_reason' generate.json)
  if [ "$REASON" != "completed" ]; then
    echo "generate exhausted: $REASON" >&2
    exit 2
  fi
fi

wraith check stripe --format json > after.json
SCORE_AFTER=$(jq '.score_bp' after.json)

if [ "$SCORE_AFTER" -lt 9500 ]; then
  echo "twin conformance below threshold: $SCORE_AFTER" >&2
  exit 2
fi
```

## When generate is the wrong tool

- **The twin is generally healthy but one route is severely broken.** Edit the variant template directly in `model/symbols.json`, or write a [Lua handler](/lua/) — generate's LLM is overkill for a known fix.
- **The upstream API actually changed.** Re-record (`wraith record` or `wraith refresh`) rather than asking the LLM to mask the drift.
- **The recordings are too thin.** Generate can't infer behavior the recordings don't show. More sessions, more variation.

Generate shines on the middle band: real divergences in real corpora that aren't trivially patchable but don't require re-recording.
