# market-bot

A research bot that produces sourced market updates and ticker briefs for equities and crypto. Each run fetches evidence, summarizes the regime, surfaces movers, emits measurable predictions, and writes a versioned artifact to disk. A built-in scoring and calibration loop grades past predictions against actual closes.

Reports are **research views**, not trading advice — no buy/sell calls, no position sizing.

## What it does

- **Daily and weekly market updates** — equity or crypto regime, FRED Market Context, top movers, themes, risks, and source gaps. Weekly is a cadence and horizon change, not a separate data product; mover inputs still come from Yahoo `day_gainers` and CoinGecko 24h change, and reports disclose this as a source gap. Optional Massive equity snapshots and news add supplemental cited evidence without changing mover ranking or scoring.
- **Ticker briefs** — deeper, single-instrument research views with optional Extended Evidence from SEC/EDGAR, Finnhub events, FRED, Tradier IV, and Glassnode.
- **Alpha search** — ApeWisdom social-momentum discovery for equity Research Leads, validated against Yahoo eligibility criteria.
- **Measurable predictions** — each report emits typed predictions (price targets, directional moves) parsed by a small DSL and validated against the report schema.
- **Scoring pass** — resolves due predictions against point or window Observations from historical closes, FRED, and Tradier IV where applicable, then writes `score.json` per run.
- **Calibration aggregator** — rolls up scored predictions, sliced by cadence (daily / weekly / ticker), into `data/calibration/summary.json` and a markdown summary.

## Setup

```sh
bun install
bunx lefthook install   # one-time — wires pre-commit, commit-msg, and pre-push hooks
cp .env.example .env    # fill in keys before running
```

## Providers

market-bot supports four LLM providers. Set `MARKET_BOT_PROVIDER` to select one.

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

Default models: `claude-sonnet-4-6` (quick), `claude-opus-4-8` (synthesis/deep). Override with `MARKET_BOT_QUICK_MODEL` / `MARKET_BOT_SYNTHESIS_MODEL`.

### Codex (ChatGPT subscription, no API key required)

```sh
npm i -g @openai/codex   # requires Node ≥ 22
codex login              # one-time — authenticates your ChatGPT session
MARKET_BOT_PROVIDER=codex bun run src/cli.ts daily --asset equity
```

Rate limits follow your ChatGPT plan tier. Model overrides use `MARKET_BOT_CODEX_QUICK_MODEL` / `MARKET_BOT_CODEX_SYNTHESIS_MODEL`.

### OpenAI-compatible endpoint

```sh
MARKET_BOT_PROVIDER=openai-compatible \
MARKET_BOT_OPENAI_API_KEY=your-key \
MARKET_BOT_BASE_URL=https://your-endpoint.example.com \
bun run src/cli.ts daily --asset equity
```

`MARKET_BOT_BASE_URL` must be `https` (or `http` for localhost). Credentials in the URL are rejected.

## CLI

Run artifacts land under `data/runs/<run-id>/` (override with `MARKET_BOT_DATA_DIR`).

### Market updates

```sh
bun run src/cli.ts daily  --asset equity|crypto [--deep]
bun run src/cli.ts weekly --asset equity|crypto [--deep]
```

Fetches regime evidence, FRED Market Context (when configured), top movers, themes, risks, and emits measurable predictions. Also runs a score pass and calibration refresh as a non-blocking side effect.

### Ticker brief

```sh
bun run src/cli.ts ticker <SYMBOL> --asset equity|crypto [--deep]
```

Single-instrument research view. `--deep` enables the Evidence Request Loop (equity only) which can pull SEC filings and Tradier IV term structure on request, runs the Coverage Panel, and uses the synthesis model.

Examples:

```sh
bun run src/cli.ts ticker AAPL --asset equity
bun run src/cli.ts ticker AAPL --asset equity --deep
bun run src/cli.ts ticker BTC  --asset crypto --deep
```

### Alpha search

```sh
bun run src/cli.ts alpha-search --asset equity [--deep]
```

Equity-only ApeWisdom discovery workflow. Ranks social-momentum candidates, validates the top N against Yahoo eligibility criteria, and emits Research Leads. Does not emit predictions or trigger score/calibration side effects.

**Default eligibility screen** (all overridable via env vars):

| Filter | Default |
| --- | --- |
| Stock type | Listed stocks only, no OTC |
| Min price | $0.50 |
| Min volume | 100,000 |
| Min market cap | $50M |
| Max market cap | $10B |

### Score and calibration

```sh
bun run src/cli.ts score          # resolve due predictions across all prior runs; refresh calibration
bun run src/cli.ts calibration    # rebuild calibration summary without running a new score pass
```

### Cache management

```sh
bun run src/cli.ts cache prune    # remove raw cache entries >30 days; close-cache entries >365 days
```

## `--deep` flag

Without `--deep`: uses the quick model (`MARKET_BOT_QUICK_MODEL`), no Evidence Request Loop, no Coverage Panel.

With `--deep`:
- Uses the synthesis model (`MARKET_BOT_SYNTHESIS_MODEL`).
- For `ticker --asset equity`: runs the Evidence Request Loop (up to `MARKET_BOT_EVIDENCE_REQUEST_MAX_ROUNDS` rounds) which can fetch SEC latest filing and Tradier IV term structure on model request.
- Runs a fixed Coverage Panel (two concurrent role-analysis stages) before critique.
- Fetches more ApeWisdom pages for `alpha-search` (`MARKET_BOT_APEWISDOM_DEEP_PAGE_LIMIT`).

## Configuration

All configuration is via environment variables. Copy `.env.example` and fill in what you need. See [docs/configuration.md](./docs/configuration.md) for the full reference.

### Required

| Variable | Notes |
| --- | --- |
| `OPENAI_API_KEY` | Required for `openai` provider. |
| `ANTHROPIC_API_KEY` | Required for `anthropic` provider. |

### Common tuning knobs

| Variable | Default | Notes |
| --- | --- | --- |
| `MARKET_BOT_PROVIDER` | `openai` | `openai`, `openai-compatible`, `codex`, or `anthropic`. |
| `MARKET_BOT_QUICK_MODEL` | `gpt-5.4-mini` / `claude-sonnet-4-6` | Model for standard depth runs. |
| `MARKET_BOT_SYNTHESIS_MODEL` | `gpt-5.5` / `claude-opus-4-8` | Model for `--deep` runs. |
| `MARKET_BOT_REASONING_EFFORT` | — | `low`, `medium`, or `high`. Unset omits provider effort params. |
| `MARKET_BOT_DATA_DIR` | `data/runs` | Where run artifacts are written. |
| `MARKET_BOT_EQUITY_MOVER_LIMIT` | `5` | Movers shown per equity update. |
| `MARKET_BOT_CRYPTO_MOVER_LIMIT` | `5` | Movers shown per crypto update. |
| `MARKET_BOT_NEWS_LIMIT` | `8` | Combined news cap per run. |

### Optional data providers

| Variable | Notes |
| --- | --- |
| `MARKET_BOT_FRED_API_KEY` | Free. Enables FRED macro context, ticker macro evidence, and FRED forecast scoring. Strongly recommended. Get a key at [fred.stlouisfed.org](https://fred.stlouisfed.org/). |
| `MARKET_BOT_SEC_USER_AGENT` | Free. Set to `market-bot your-email@example.com` for live SEC EDGAR access. US-centric; international coverage is an expected provider gap. |
| `MARKET_BOT_MARKETAUX_API_TOKEN` | Optional paid news. Missing token emits a `SourceGap`; Yahoo news still runs. |
| `MARKET_BOT_FINNHUB_API_TOKEN` | Optional news / events. Missing token emits a `SourceGap`. |
| `MARKET_BOT_TRADIER_API_TOKEN` | Optional equity options / IV evidence and IV forecast scoring. Free/delayed access depends on Tradier plan. |
| `MARKET_BOT_GLASSNODE_API_KEY` | Optional crypto on-chain evidence (paid/API-add-on plan required). |
| `MARKET_BOT_MASSIVE_API_KEY` | Optional supplemental equity news and stock snapshots (formerly Polygon.io, uses `api.massive.com`). Does not affect mover ranking or scoring. |

**Recommended free setup** — set `MARKET_BOT_FRED_API_KEY` and `MARKET_BOT_SEC_USER_AGENT`. These two unlock the most value at no cost. Add `MARKET_BOT_TRADIER_API_TOKEN` only if you need equity options/IV evidence.

### Alpha search tuning

| Variable | Default | Notes |
| --- | --- | --- |
| `MARKET_BOT_APEWISDOM_FILTER` | `all-stocks` | ApeWisdom feed filter. |
| `MARKET_BOT_APEWISDOM_BRIEF_PAGE_LIMIT` | `5` | Pages fetched for standard `alpha-search`. |
| `MARKET_BOT_APEWISDOM_DEEP_PAGE_LIMIT` | `10` | Pages fetched for `alpha-search --deep`. |
| `MARKET_BOT_ALPHA_SEARCH_VALIDATION_LIMIT` | `25` | Top-N candidates sent to Yahoo validation. |
| `MARKET_BOT_ALPHA_SEARCH_LEAD_LIMIT` | `15` | Max Research Leads in report. |
| `MARKET_BOT_ALPHA_SEARCH_MIN_PRICE` | `0.50` | Minimum regular-market price. |
| `MARKET_BOT_ALPHA_SEARCH_MIN_VOLUME` | `100000` | Minimum regular-market volume. |
| `MARKET_BOT_ALPHA_SEARCH_MIN_MARKET_CAP` | `50000000` | Minimum market cap ($50M). |
| `MARKET_BOT_ALPHA_SEARCH_MAX_MARKET_CAP` | `10000000000` | Maximum market cap ($10B). |

### Evidence request (deep ticker only)

| Variable | Default | Notes |
| --- | --- | --- |
| `MARKET_BOT_EVIDENCE_REQUEST_MAX_ROUNDS` | `2` | Model rounds. Set to `0` to disable. |
| `MARKET_BOT_EVIDENCE_REQUEST_MAX_TOOL_CALLS` | `2` | Accepted tool executions per run. |
| `MARKET_BOT_EVIDENCE_REQUEST_SOURCE_BUDGET` | `8` | Max declared source units (SEC filing costs 3; Tradier IV costs 5). |

### Cache

| Variable | Default | Notes |
| --- | --- | --- |
| `MARKET_BOT_CACHE_DIR` | `data/cache` | Cache directory for raw sources and close-cache entries. |
| `MARKET_BOT_CACHE_DISABLE` | `false` | Set to `1` or `true` to bypass cache entirely. |
| `MARKET_BOT_CACHE_FALLBACK_DAYS` | `7` | Days to serve a stale cached payload when a live fetch fails. |

## Data output layout

```
data/
  runs/
    <run-id>/
      report.json       Zod-validated report artifact
      report.md         Markdown-rendered report
      score.json        Scored predictions for this run (written after score pass)
  calibration/
    summary.json        Rolled-up calibration across all scored runs
    summary.md          Markdown calibration summary
  cache/
    <YYYY-MM-DD>/       Per-day raw source cache entries (sha256-keyed)
    closes/             Scorer close-cache entries
  news-seen.json        Persistent seen-news index (suppresses repeats for 30 days)
```

## Development

| Command | Purpose |
| --- | --- |
| `bun test` | Run all tests |
| `bun run typecheck` | TypeScript `--noEmit` |
| `bun run lint` | oxlint |
| `bun run fmt` | Format with oxfmt |
| `bun run fmt:check` | Check formatting without writing |
| `bun run knip` | Find unused exports and dependencies |
| `bun run audit` | High-severity vulnerability scan |
| `bun run check` | lint + fmt:check + typecheck + test (CI gate) |

`bun run check` must pass before any commit. Do not bypass hooks (`--no-verify`).

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
  alpha-search/      ApeWisdom discovery, ranking, validation
  research/          Orchestrator, regime summarization, Domain Playbooks
  scoring/           Prediction DSL, resolver, scoring, calibration
  sources/           Provider modules, normalized adapters, collector, retry/backoff/cache
prompts/             Stage prompt files and checked-in Domain Playbooks
tests/               Bun test suites
data/                Run artifacts and calibration output (gitignored)
docs/adr/            Architecture decision records
```

## Further reading

- [CONTEXT.md](./CONTEXT.md) — domain glossary
- [docs/architecture.md](./docs/architecture.md) — subsystems and data flow
- [docs/configuration.md](./docs/configuration.md) — full env var reference
- [docs/conventions.md](./docs/conventions.md) — code style, testing, commits
- [docs/source-provider-contract.md](./docs/source-provider-contract.md) — adding source providers
- [docs/adr/](./docs/adr/) — design decisions
- [CONTRIBUTING.md](./CONTRIBUTING.md) — git hooks and contributor guide
