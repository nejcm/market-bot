# market-bot

A research bot that produces sourced market updates and ticker briefs for equities and crypto. Each run fetches evidence, summarizes the regime, surfaces movers, emits measurable predictions, and writes a versioned artifact to disk. A built-in scoring and calibration loop grades past predictions against actual closes.

Reports are **research views**, not trading advice — no buy/sell calls, no position sizing.

## What it does

- **Daily and weekly market updates** — equity or crypto regime, top movers, themes, risks, and source gaps. Weekly is a cadence and horizon change, not a separate data product; mover inputs still come from Yahoo `day_gainers` and CoinGecko 24h change, and reports disclose this as a source gap.
- **Ticker briefs** — deeper, single-instrument research views with optional Extended Evidence from SEC/EDGAR, Finnhub events, FRED, Tradier IV, and Glassnode.
- **Measurable predictions** — each report emits typed predictions (price targets, directional moves) parsed by a small DSL and validated against the report schema.
- **Scoring pass** — resolves due predictions against historical closes, FRED observations, and Tradier IV where applicable, then writes `score.json` per run.
- **Calibration aggregator** — rolls up scored predictions, sliced by cadence (daily / weekly / ticker), into `data/calibration/summary.json` and a markdown summary.

## Quick start

**API key (default)**

```sh
bun install
bunx lefthook install   # one-time, wires git hooks

export OPENAI_API_KEY=sk-...
bun run src/cli.ts daily --asset equity
```

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
market-bot score
market-bot calibration
```

- `--deep` switches to the synthesis model for a more thorough pass.
- `score` resolves any due predictions across previous runs and refreshes the calibration summary.
- `calibration` rebuilds the calibration summary without scoring.
- Daily / weekly / ticker runs also run a score pass and calibration refresh as a side effect; failures there are logged but do not block the research job.

## Configuration

All configuration is via environment variables.

| Variable | Default | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` / `MARKET_BOT_OPENAI_API_KEY` | — | Required for `openai`. `openai-compatible` only reads `MARKET_BOT_OPENAI_API_KEY`. |
| `MARKET_BOT_PROVIDER` | `openai` | `openai`, `openai-compatible`, or `codex`. |
| `MARKET_BOT_BASE_URL` | — | Required only when provider is `openai-compatible`; must be `https` unless localhost. |
| `MARKET_BOT_QUICK_MODEL` | `gpt-5.4-mini` | Used for brief depth. |
| `MARKET_BOT_SYNTHESIS_MODEL` | `gpt-5.5` | Used for `--deep`. |
| `MARKET_BOT_DATA_DIR` | `data/runs` | Where run artifacts are written. |
| `MARKET_BOT_EQUITY_MOVER_LIMIT` | `5` | Movers per equity update. |
| `MARKET_BOT_CRYPTO_MOVER_LIMIT` | `5` | Movers per crypto update. |
| `MARKET_BOT_NEWS_LIMIT` | `8` | News items per run. |
| `MARKET_BOT_SOURCE_TIMEOUT_MS` | `15000` | Per-source fetch timeout. |
| `MARKET_BOT_MARKETAUX_API_TOKEN` | — | Enables MarketAux news. |
| `MARKET_BOT_FINNHUB_API_TOKEN` | — | Enables Finnhub news and ticker equity events. |
| `MARKET_BOT_FRED_API_KEY` | — | Enables ticker FRED evidence and FRED forecast scoring. |
| `MARKET_BOT_TRADIER_API_TOKEN` | — | Enables ticker options/IV evidence and IV forecast scoring. |
| `MARKET_BOT_GLASSNODE_API_KEY` | — | Enables ticker Glassnode on-chain evidence for crypto. |
| `MARKET_BOT_SEC_USER_AGENT` | `market-bot research contact@example.invalid` | User-Agent sent to SEC EDGAR. |

## Layout

```
src/
  app.ts             CLI entrypoint glue
  cli/args.ts        Argument parsing
  config.ts          Environment-driven configuration
  domain/            Instrument, asset class, depth, prediction types
  model/             OpenAI / OpenAI-compatible provider
  movers/            Mover ranking
  report/            Report schema + markdown renderer
  research/          Orchestrator, regime summarization
  scoring/           Prediction DSL, resolver, scoring, calibration
  sources/           Yahoo, CoinGecko, news, collector, retry/backoff
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

See [CONTRIBUTING.md](./CONTRIBUTING.md) for git hooks and commit conventions, [CONTEXT.md](./CONTEXT.md) for the domain glossary, and [docs/adr/](./docs/adr/) for design decisions.
