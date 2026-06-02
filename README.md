# market-bot

A research bot that produces sourced market updates and ticker briefs for equities and crypto. Each run fetches evidence, summarizes the regime, surfaces movers, emits measurable predictions, and writes a versioned artifact to disk. A built-in scoring and calibration loop grades past predictions against actual closes.

Reports are **research views**, not trading advice — no buy/sell calls, no position sizing.

## What it does

- **Daily and weekly market updates** — equity or crypto regime, FRED Market Context, top movers, themes, risks, and source gaps. Weekly is a cadence and horizon change, not a separate data product; mover inputs still come from Yahoo `day_gainers` and CoinGecko 24h change, and reports disclose this as a source gap. Optional Massive equity snapshots and news add supplemental cited evidence without changing mover ranking or scoring.
- **Ticker briefs** — deeper, single-instrument research views with optional Extended Evidence from SEC/EDGAR, Finnhub events, FRED, Tradier IV, and Glassnode.
- **Measurable predictions** — each report emits typed predictions (price targets, directional moves) parsed by a small DSL and validated against the report schema.
- **Scoring pass** — resolves due predictions against point or window Observations from historical closes, FRED, and Tradier IV where applicable, then writes `score.json` per run.
- **Calibration aggregator** — rolls up scored predictions, sliced by cadence (daily / weekly / ticker), into `data/calibration/summary.json` and a markdown summary.

## Quick start

**API key (default)**

```sh
bun install
bunx lefthook install   # one-time, wires git hooks

export OPENAI_API_KEY=sk-...
bun run src/cli.ts daily --asset equity
```

**Claude / Anthropic API**

```sh
export ANTHROPIC_API_KEY=sk-ant-...
MARKET_BOT_PROVIDER=anthropic bun run src/cli.ts daily --asset equity
```

Uses Claude defaults unless `MARKET_BOT_QUICK_MODEL` or `MARKET_BOT_SYNTHESIS_MODEL` is set.

**ChatGPT / Codex subscription (no API key required)**

```sh
codex login                        # one-time, authenticates your ChatGPT session
MARKET_BOT_PROVIDER=codex bun run src/cli.ts daily --asset equity
```

Requires `codex` CLI ≥ 0.125 (`npm i -g @openai/codex`, Node ≥ 22). Rate limits follow your ChatGPT plan tier.

Run artifacts land under `data/runs/<run-id>/` (override with `MARKET_BOT_DATA_DIR`).

## CLI

```
market-bot daily   --asset equity|crypto [--deep]
market-bot weekly  --asset equity|crypto [--deep]
market-bot ticker  <symbol> --asset equity|crypto [--deep]
market-bot alpha-search --asset equity [--deep]
market-bot score
market-bot calibration
```

- `--deep` switches to the synthesis model for a more thorough pass.
- `alpha-search` is an equity-only Reddit-first discovery workflow; it ranks Reddit discussion, Yahoo-validates the top candidates, emits no predictions, and does not trigger score/calibration side effects in V1.
- `score` resolves any due predictions across previous runs and refreshes the calibration summary.
- `calibration` rebuilds the calibration summary without scoring.
- Daily / weekly / ticker runs also run a score pass and calibration refresh as a side effect; failures there are logged but do not block the research job.

## Configuration

All configuration is via environment variables. Check .env.example for the list of all env variables.


## Layout

```
src/
  app.ts             CLI entrypoint glue
  cli/args.ts        Argument parsing
  config.ts          Environment-driven configuration
  config/runs.ts     Typed per-run config
  domain/            Instrument, asset class, depth, prediction types
  forecast/          Observable forecast contract and resolver helpers
  model/             OpenAI / OpenAI-compatible / Codex / Anthropic providers
  movers/            Mover ranking
  report/            Report schema + markdown renderer
  research/          Orchestrator, regime summarization
  scoring/           Prediction DSL, resolver, scoring, calibration
  sources/           Provider modules, normalized adapters, collector, retry/backoff/cache
tests/               Bun test suites
data/                Run artifacts and calibration output (gitignored)
docs/adr/            Architecture decision records
```

## Development

| Script | Purpose |
| --- | --- |
| `bun test` | Run all tests |
| `bun run typecheck` | TypeScript --noEmit |
| `bun run lint` | oxlint |
| `bun run fmt` / `fmt:check` | oxfmt |
| `bun run knip` | Find unused exports / deps |
| `bun run audit` | High-severity vuln scan |
| `bun run check` | lint + fmt:check + typecheck + test |

See [CONTRIBUTING.md](./CONTRIBUTING.md) for git hooks and commit conventions, [CONTEXT.md](./CONTEXT.md) for the domain glossary, [docs/architecture.md](./docs/architecture.md) for subsystem details, [docs/source-provider-contract.md](./docs/source-provider-contract.md) for adding source providers, and [docs/adr/](./docs/adr/) for design decisions.
