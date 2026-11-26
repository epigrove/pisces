# dsh-koi-decay

[中文](./README.zh-CN.md) | English

Shared decay math and record-index primitives for memories, impressions, emotions, and visibility decisions.

## What it does

- Computes `w(t) = (t + 1)^(-alpha)` with `weight(elapsedDays, alpha)` and converts half-lives or fade thresholds into `alpha`.
- Combines positive and negative evidence with union probability instead of an unbounded linear sum.
- Normalizes legacy flat records and newer record envelopes into one in-memory shape.
- Records stale markers and recall touches in a sidecar index without rewriting the append-only memory ledger.
- Maintains ledger fingerprints and a refresh audit to detect out-of-band edits.
- Shares person-key, mention-day, and short-memory-window contracts used by other memory packages.

## Design rationale

- **One dependency boundary.** Several plugins previously borrowed decay code through relative paths into lexicon. Installing one consumer alone or moving a directory broke module resolution. Moving the math into its own package makes the dependency explicit and independent of plugin layout.
- **Power law, not exponential or logarithmic decay.** Exponential decay loses its long tail, while the old logarithmic formula lost new memories fastest. `(t + 1)^(-alpha)` starts gradually and leaves a long tail, so old records remain discoverable.
- **Weights never become zero.** Zero would make deliberate recall impossible and silently turn "do not inject" into deletion. `SHOW_THRESHOLD = 0.1` and `FADE_THRESHOLD = 0.3` control presentation instead.
- **Half-life has an explicit meaning.** `halfToCurve(H) = ln(2) / ln(H + 1)`, so `H` is the time when weight reaches one-half. The `+1` is the curve's zero-time offset, not an extra retained day. `curveForZero(d)` finds when weight reaches `0.1`; crossing that line means fading from injection, not deletion.
- **Union probability prevents repetition from pinning the score.** `1 - product(1 - a_i)` remains below `1`; several moderate observations become strong without becoming infinite. Positive and negative evidence accumulate separately before subtraction.
- **Ledger and index have different contracts.** The memory ledger is append-only, while stale and recall state is derived data in `medium.index.json`. A broken index can be rebuilt without losing source records and is never overwritten with an empty object after backup failure.
- **Integrity must be observable.** Fingerprints compare line count, byte count, and SHA-256 against a recorded baseline. They detect bypass edits, though they cannot prove that a refreshed baseline is semantically correct.

## Configuration

This package reads no plugin configuration keys.

| Key | Default | Effect |
|---|---|---|
| None | None | Behavior is controlled by exported constants and function arguments. |

## Interface

There is no Cordis plugin id, `apply()` function, prompt section, tool, or event subscription.

| Name | Type | Effect |
|---|---|---|
| `weight`, `score`, `accumulate` | functions | Compute time weights and combined evidence. |
| `halfToCurve`, `curveForZero`, `alphaFromHalfLife`, `dayAtWeight` | functions | Convert between human time scales, `alpha`, and threshold dates. |
| `DEFAULT_HALF_DAYS`, `SHOW_THRESHOLD`, `FADE_THRESHOLD`, `REST_DAYS`, `SHORT_MAX_ITEMS` | constants | Shared timing and visibility defaults. |
| `normalizeRecord`, `hiddenReason`, `shouldSkipComputation`, `validateWrite` | functions | Normalize, classify, and validate envelopes. |
| `personKeyOf`, `isEmptyPerson`, `markMentioned`, `isMentionedToday` | functions | Apply shared person and mention semantics. |
| `readIndexResult`, `writeIndex`, `touch`, `checkLedger`, `recordLedger` | sidecar exports | Read and atomically update indexes and fingerprints. |

## Verify

Run from the repository root:

```bash
for f in plugins/dsh-koi-decay/test-*.mjs; do node "$f" || exit 1; done
```

Each assertion prints `✅` or `❌`, and each script ends with `N 通过 / 0 失败`. A successful run exits with status `0`.

## Notes / Limitations

- This is a library package, not a mounted plugin.
- Sidecar writes use temporary-file replacement but provide no cross-process lock. Separate writers can still race; unknown index buckets are preserved to reduce accidental loss.
- Fingerprints detect drift between a ledger and its baseline. They cannot detect a semantically wrong but internally consistent rewrite.
- `stabilityToAlpha()` and `legacyHalfToAlpha()` preserve migration behavior; they do not define the new curve design.
