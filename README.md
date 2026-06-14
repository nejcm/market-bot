<p align="center">
  <img src="./assets/logo.png" alt="market-bot logo" width="128" />
</p>

<h1 align="center">market-bot</h1>

<p align="center">
  A Bun + TypeScript CLI that turns public market data into sourced research artifacts — with measurable predictions, scoring, and calibration.
</p>

<p align="center">
  <a href="https://github.com/nejcm/market-bot/actions/workflows/ci.yml"><img src="https://github.com/nejcm/market-bot/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
</p>

> **Research-only.** Reports are sourced research views — not trading advice. No buy/sell calls, position sizing, execution, or portfolio actions. Predictions are observable forecasts scored for calibration, not trade signals.

## Quick start

**Requirements:** [Bun](https://bun.sh) ≥ 1.1 (tested with 1.3.x), an LLM provider key (or [Codex](#codex-chatgpt-subscription-no-api-key-required) login), and optionally free [FRED](https://fred.stlouisfed.org/) + [SEC EDGAR](https://www.sec.gov/edgar/search/) credentials for richer evidence.

```sh
git clone https://github.com/nejcm/market-bot.git
cd market-bot
bun install
bunx lefthook install   # optional — git hooks for contributors
cp .env.example .env    # see comments in .env.example for required and optional keys
```

Run a daily equity market update:

```sh
export OPENAI_API_KEY=sk-...
bun run src/cli.ts daily --asset equity
```

Artifacts land under `data/runs/<run-id>/` (`report.json`, `report.md`, normalized snapshots, and more). See [Data output layout](#data-output-layout).

## What it does

| Capability | Summary |
| --- | --- |
| **Market updates** | Daily / weekly equity or crypto regime, movers, themes, risks, source gaps, optional Market Spotlights |
| **Ticker briefs** | Single-instrument research with Extended Evidence (SEC, Finnhub, FRED, Tradier IV, Glassnode, valuation) |
| **Alpha search** | Equity social-momentum discovery (ApeWisdom + SEC filings) → validated Research Leads |
| **Predictions** | Typed forecasts via a small DSL; claims rendered from `measurableAs` ([ADR 0020](./docs/adr/0020-claim-rendered-from-dsl.md)); soft target count ([ADR 0021](./docs/adr/0021-prediction-count-soft-target.md)) |
| **Scoring & calibration** | Resolves due predictions against public Observations; Brier skill vs 0.5 baseline |
| **Cross-run intelligence** | Historical context, error correction on prior misses, searchable history, thesis deltas |
| **Research Console** | Local Svelte UI to browse runs, search artifacts, view calibration, queue jobs |

Weekly updates change cadence and prediction horizon; mover inputs still come from daily-style Yahoo screeners and CoinGecko 24h fields — disclosed as source gaps in reports.

## Research Console

Browse existing artifacts without changing the research-only boundary:

```sh
bun run app:build
bun run app
```

Opens at `http://127.0.0.1:4173`. Reads run artifacts from the configured data directory; supports run search, score badges, calibration charts, provider health, and allowlisted job queueing. Console settings are in [`.env.example`](./.env.example).

## CLI

Install globally via Bun, or invoke with `bun run src/cli.ts`:

```sh
bun link          # optional — adds `market-bot` to PATH from this clone
market-bot daily --asset equity
```

| Command | Purpose |
| --- | --- |
| `daily` / `weekly --asset equity\|crypto` | Market update with predictions; optional `--deep` |
| `ticker <SYMBOL> --asset equity\|crypto` | Single-instrument brief; `--deep` adds Evidence Request Loop + Coverage Panel (equity) |
| `alpha-search --asset equity` | Research Leads only — no predictions or calibration side effects |
| `score` | Resolve due predictions across prior runs |
| `calibration` | Rebuild calibration summary + print reliability dashboard |
| `index rebuild` | Bootstrap / rebuild SQLite Run Artifact Index |
| `history rebuild` / `search` / `thesis-delta` | Artifact-only cross-run search and thesis comparison |
| `provider-health` | Validation report over persisted runs and provider coverage |
| `cache prune` | Drop stale source and close-cache entries |

Full command reference: [docs/how-it-works.md](./docs/how-it-works.md).

### Examples

```sh
bun run src/cli.ts daily  --asset equity
bun run src/cli.ts weekly --asset crypto --deep
bun run src/cli.ts ticker AAPL --asset equity --deep
bun run src/cli.ts alpha-search --asset equity
bun run src/cli.ts score
bun run src/cli.ts calibration
bun run src/cli.ts history search --query catalyst
```

## LLM providers

Set `MARKET_BOT_PROVIDER` to select one.

### OpenAI (default)

```sh
export OPENAI_API_KEY=sk-...
bun run src/cli.ts daily --asset equity
```

### Anthropic

```sh
export ANTHROPIC_API_KEY=sk-ant-...
MARKET_BOT_PROVIDER=anthropic bun run src/cli.ts daily --asset equity
```

Defaults: `claude-sonnet-4-6` (quick), `claude-opus-4-8` (synthesis / `--deep`).

### Codex (ChatGPT subscription, no API key required)

```sh
npm i -g @openai/codex   # requires Node ≥ 22
codex login
MARKET_BOT_PROVIDER=codex bun run src/cli.ts daily --asset equity
```

### OpenAI-compatible endpoint

```sh
MARKET_BOT_PROVIDER=openai-compatible \
MARKET_BOT_OPENAI_API_KEY=your-key \
MARKET_BOT_BASE_URL=https://your-endpoint.example.com \
bun run src/cli.ts daily --asset equity
```

`MARKET_BOT_BASE_URL` must be `https` (or `http` for localhost). Credentials in the URL are rejected.

## `--deep` flag

| | Brief (default) | `--deep` |
| --- | --- | --- |
| Model | Quick model | Synthesis model |
| Coverage panel | No | Yes — two concurrent role stages before critique |
| Evidence Request Loop | No | Yes — equity ticker only; SEC filing + Tradier IV on request |
| Alpha search pages | Brief limit | Deep page limit |

## Configuration

Copy [`.env.example`](./.env.example) to `.env` and set the variables you need. Each entry is commented there with defaults and purpose. For provider behavior, gaps, and tuning notes, see [docs/configuration.md](./docs/configuration.md).

## Data output layout

```
data/
  runs/<run-id>/          report.json, report.md, score.json, normalized/, trace.json
  calibration/            summary.json, summary.md
  index.sqlite            derived Run Artifact Index (optional, rebuildable)
  history/                derived search index + instrument timelines
  cache/                  raw source + close caches
  news-seen.json          suppresses repeat news URLs (30 days)
```

## Development

```sh
bun run check    # lint + fmt:check + typecheck + test — must pass before merge
bun test
bun run typecheck
bun run lint
bun run fmt
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for hooks, commit format, and CI expectations.

## Project layout

```
src/           CLI, orchestrator, sources, scoring, report schema
app/           Research Console (Svelte + Bun server)
prompts/       Model stage prompts and Domain Playbooks
tests/         Bun test suites
docs/          Architecture, configuration, ADRs
assets/        Logo and favicons
```

## Further reading

- [docs/how-it-works.md](./docs/how-it-works.md) — end-to-end flow and command behavior
- [CONTEXT.md](./CONTEXT.md) — domain glossary
- [docs/architecture.md](./docs/architecture.md) — subsystems and data flow
- [`.env.example`](./.env.example) — environment variable template
- [docs/configuration.md](./docs/configuration.md) — configuration reference and provider notes
- [docs/conventions.md](./docs/conventions.md) — code style, testing, commits
- [docs/adr/](./docs/adr/) — design decisions
- [SECURITY.md](./SECURITY.md) — vulnerability reporting

## License

[MIT](./LICENSE) © Nejc
