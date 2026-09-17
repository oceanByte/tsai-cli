# tsai

> [!IMPORTANT]
> **This is not an official TypeSafe product.** It is an unofficial, unaffiliated
> third-party client written by [@oceanByte](https://github.com/oceanByte) to test
> and prototype against the [TypeSafe](https://typesafe.ai) System One API across a
> few personal agent systems.
>
> TypeSafe did not build, review, endorse or support it, and is not responsible for
> it. Please do not file issues about this CLI with them; open them
> [here](https://github.com/oceanByte/tsai-cli/issues) instead. For anything
> production-facing, use TypeSafe's own [SDKs and
> documentation](https://docs.typesafe.ai).

An unofficial command-line wrapper around the TypeSafe System One API. Jev is a
System One model: you supply state and typed questions, and get structured numbers
your code can use directly, with no prose to parse and no JSON schema to validate.
This CLI puts that behind a shell command.

Built for the throwaway end of the spectrum: a shell pipeline, a scratch CI gate, a
pre-commit hook, or a coding agent that needs a judgment without a client library.
It is a prototyping tool and is versioned like one, so expect breaking changes.

```console
$ tsai noul -i "Does this diff leak a credential?" --state-file patch.diff
  answer   0.96  ██████████  p(yes)

$ tsai noul -i "Does this diff leak a credential?" --state-file patch.diff --field answers.answer.noul
0.96
```

Output adapts automatically: formatted bars for interactive terminals, raw floats or compact JSON when piped.

## Quickstart

The package is `tsai-cli`; the command it installs is `tsai`.

```bash
pnpm add -g tsai-cli
# Or ad-hoc: bunx tsai-cli / npx tsai-cli
```

You will also need a TypeSafe account and API key, which you get from
[TypeSafe](https://typesafe.ai) directly. This project does not resell, proxy or
provision access; it only talks to their API with credentials you already hold.

Authenticate locally:

```bash
tsai auth login          # prompts securely, writes key at mode 0600
tsai auth status         # verifies token against the API
```

The key is written to `~/.config/tsai/config.json` and is never logged. In CI, set `TYPESAFE_API_KEY` in your environment; it takes precedence over stored credentials.

## Primitives

TypeSafe provides three atomic question types. Any primitive becomes a gate when given an assertion flag (`--min-noul`, `--expect`, or `--max-score`). A failed gate exits `6` after reporting the value, keeping semantic disagreement distinct from execution failure.

### `noul`

Evaluates whether a condition holds over the provided state. It returns a single probability: $p(\text{yes})$. 

A noul carries no confidence score by design: a value near `0.5` means yes and no are equally likely, not that the model is confused. Use one noul per property when multiple conditions can hold simultaneously.

```bash
# Basic evaluation
tsai noul -i "Is this a bug report rather than a feature request?" ticket.txt

# Gated CI check: exits 6 if p(yes) < 0.8
tsai noul -i "Does this commit explain why the change was made?" --min-noul 0.8 msg.txt
```

### `choice`

Selects one option from a closed set (up to 255 candidates) and reports the full probability distribution, plus a confidence score measuring distribution concentration. The answer tells you what; confidence tells you whether to act automatically or route to review.

`--none` appends an escape candidate so the model is not forced to select a poor fit.

```bash
tsai choice -i "Which service owns this failure?" \
  -c "api=HTTP routing and gateway" \
  -c "auth=tokens and permissions" \
  -c "db=migrations and queries" \
  --none incident.log

# Gated assertion: requires a specific label with minimum confidence
tsai choice -i "Target environment?" -c staging -c prod --expect staging --min-confidence 0.85 deploy.env
```

### `score`

Rates state against an ordered rubric of 2 to 10 discrete levels. Returns a probability-weighted float that lands between levels when evidence is mixed.

```bash
tsai score -i "How severe is this incident?" \
  -l "No user impact" \
  -l "Degraded performance" \
  -l "Core flow blocked" \
  -l "Total outage" \
  --max-score 2.0 incident.md
```

### `ask` (Speculative Fan-out)

Evaluates an arbitrary question set over the same state in a single request, so one set of state is sent once rather than once per question. Ask everything you might need up front and let your code consume what applies. See TypeSafe's [documentation](https://docs.typesafe.ai) for how requests are billed.

```bash
tsai ask --questions checks.json --state-file report.md
echo "$TEXT" | tsai ask -q '{"urgent":{"type":"noul","instructions":"Needs immediate response?"}}'
```

Inspect the questions schema with `tsai schema`, or generate an example template with `tsai schema --example`.

## Recipes

Pre-built recipes combining deterministic code with System One judgments. Where ordinary code can settle an invariant on its own (such as checking a quoted span appears verbatim), the recipe does that locally and skips the API call.

| Command | What it does | Example |
| --- | --- | --- |
| `screen` | Evaluates text across a hazard battery; resolves to pass, review, or block | `curl -s "$URL" \| tsai screen --fail-on block` |
| `review` | Runs a multi-point convention checklist against a git diff in one request | `tsai review --staged --fail-on 0.9` |
| `verify` | Checks claims against source text; verifies quoted spans in code first | `tsai verify --claim 'timeout is "60s"' config.ts` |
| `rank` | Re-ranks textual candidates by relevance to a task description | `fd -e ts . \| tsai rank --task "parses CLI flags"` |
| `find` | Locates the line answering a query and outputs `file:line` | `tsai find -t "default timeout setting" config.ts` |
| `classify` | Walks a hierarchical taxonomy tree using beam search | `tsai classify --tree taxonomy.json ticket.txt` |
| `extract` | Selects a substring from text by candidate choice (never generates) | `tsai extract --target "version" release.txt` |

## Batch Processing

High-throughput streaming over NDJSON files. Items are processed concurrently with preserved ordering, and individual line errors do not terminate the run.

```bash
cat tickets.ndjson | tsai batch --questions triage.json --concurrency 8 > triaged.ndjson
```

Input lines can be JSON objects (`{"id": "...", "state": ...}`), raw JSON values, or plain text strings.

## Machine-Native Agent Usage

Agents should introspect the CLI contract dynamically instead of guessing flags:

```bash
tsai help --json
```

Key agent invariants:
- **Zero cost for invalid inputs.** Missing state files, rubric violations, duplicate question IDs, or choices exceeding 255 options fail locally with exit `2` before reaching the network.
- **Dry runs.** Pass `--dry-run` to print the exact resolved payload and exit `0` without making an API call.
- **Deterministic payload caching.** Identical requests are cached against a SHA-256 hash of the normalized payload. Loops and idempotent retries incur no token cost. Pass `--no-cache` to bypass.
- **Read probabilities, not labels.** Thresholds depend on domain risk. Code should branch on raw probabilities rather than assuming static defaults.

## Exit Codes

Exit codes form a strict programmatic contract:

| Code | Meaning |
| --- | --- |
| `0` | Success; all assertions passed |
| `1` | Internal CLI bug |
| `2` | Local usage error; caught before billing |
| `3` | Authentication or authorization failure |
| `4` | Rate limit exhausted after local retries |
| `5` | Upstream server error |
| `6` | **Gate not met** (semantic check failed; distinct from an operational error) |
| `7` | Network failure or timeout |

## Configuration

Precedence order: CLI flags > environment variables > `./tsai.config.json` > `~/.config/tsai/config.json` > defaults. Run `tsai config` to inspect the active layer for each key.

| Variable | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | — | API authentication token |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | API endpoint |
| `TYPESAFE_DEFAULT_MODEL`| `jev-latest` | Target model |
| `TYPESAFE_STDIN_TIMEOUT`| `5000` | Milliseconds to wait for stdin before failing (set `0` to wait indefinitely) |

## Cost estimates

Run footers show the token counts the API reported, plus a **local estimate** of what
they cost; pass `--quiet` to suppress. Token counts come from the API and are exact.
The dollar figure does not: it is computed from a per-token rate hardcoded in
`src/core/cost.ts`, copied by hand from TypeSafe's published pricing and updated
only when someone here notices it changed.

Treat it as a rough ordering signal, never as a bill. [TypeSafe's own
pricing](https://docs.typesafe.ai/models) and your invoice are the only authorities.

```bash
tsai cache stats     # reports local disk cache entries and size
tsai cache clear     # flushes the cache
```

## License and trademarks

This CLI is MIT licensed. See [LICENSE](./LICENSE).

"TypeSafe" and "Jev" are the marks of their owner. They are used here only to say
what this client connects to, never to suggest affiliation, sponsorship or
endorsement, and no claim to them is made or implied.

This project asserts no right to the name. TypeSafe's Master Customer Agreement
(§15.4) grants neither party the right to use the other's name or brand without
prior consent, and no such consent has been sought or given here. If TypeSafe wants
the package or command renamed, or this project taken down, open an issue and I will
do it promptly and without argument.
