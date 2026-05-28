# TradingAgents Research

Research target: https://github.com/TauricResearch/TradingAgents

Snapshot reviewed:
- Repository: `TauricResearch/TradingAgents`
- Default branch: `main`
- Commit: `61522e103e61601c553b4544abcd53fa7ebf9f1d`
- Latest local tag: `v0.2.5`
- Package version: `0.2.5`
- License: Apache-2.0
- Created: 2024-12-28
- Last repo update observed through GitHub CLI: 2026-05-18T18:03:08Z
- Stars/forks observed through GitHub CLI: 76,866 stars, 14,978 forks
- Primary paper: https://arxiv.org/abs/2412.20138

## Executive Summary

TradingAgents is an open-source, Python-based multi-agent LLM framework for financial market analysis and trading-decision research. It models a trading firm as a LangGraph workflow: analyst agents gather market, sentiment, news, and fundamentals evidence; bull and bear researchers debate the evidence; a research manager forms an investment plan; a trader turns the plan into a transaction proposal; three risk analysts debate the proposal; and a portfolio manager emits the final rating.

The project is not an automated broker or execution engine. It produces research reports and a final recommendation such as `Buy`, `Overweight`, `Hold`, `Underweight`, or `Sell`. The README explicitly frames it as research software, not financial advice.

The current codebase is a CLI/package hybrid. Users can run an interactive terminal app or import `TradingAgentsGraph` and call `propagate(ticker, trade_date)`. It supports many LLM providers, data routing across yfinance and Alpha Vantage, persistent decision memory, optional LangGraph checkpoint resume, Docker execution, and a pytest suite focused on provider behavior, ticker safety, structured outputs, memory, checkpointing, and dataflow config.

## What It Does

TradingAgents answers: given an instrument and trade date, what should a simulated trading team do?

Inputs:
- Ticker/instrument, preserving exchange suffixes like `.T`, `.HK`, `.TO`, `-USD`.
- Trade date in `YYYY-MM-DD`.
- Asset type, currently stock by default, with analysis-only crypto support in recent commits.
- Selected analyst set: market, sentiment/social wire key, news, fundamentals.
- LLM provider/model choices and debate-depth settings.

Outputs:
- Analyst reports: technical market, sentiment, news/macro, fundamentals.
- Bull/bear investment debate transcript.
- Research Manager investment plan.
- Trader transaction proposal.
- Aggressive/conservative/neutral risk debate transcript.
- Portfolio Manager final decision.
- Parsed final signal: one of `Buy`, `Overweight`, `Hold`, `Underweight`, `Sell`.
- Saved JSON state under `~/.tradingagents/logs/<ticker>/TradingAgentsStrategy_logs/`.
- Persistent markdown decision log under `~/.tradingagents/memory/trading_memory.md`.

## User-Facing Modes

### CLI

The installed command is:

```bash
tradingagents
```

The source-mode alternative is:

```bash
python -m cli.main
```

The CLI asks for ticker, date, analyst set, research depth, LLM provider/model, output language, provider-specific reasoning/thinking options, and checkpoint options. It uses Rich/Typer/Questionary for terminal UI, streams agent progress, tracks LLM/tool stats, and can save reports to disk.

### Python API

The core usage pattern is:

```python
from tradingagents.graph.trading_graph import TradingAgentsGraph
from tradingagents.default_config import DEFAULT_CONFIG

config = DEFAULT_CONFIG.copy()
config["llm_provider"] = "openai"
config["deep_think_llm"] = "gpt-5.4"
config["quick_think_llm"] = "gpt-5.4-mini"

ta = TradingAgentsGraph(debug=True, config=config)
final_state, decision = ta.propagate("NVDA", "2026-01-15")
```

`decision` is the parsed final rating. `final_state` contains all intermediate reports and debates.

### Docker

The Dockerfile is a two-stage Python 3.12 slim build. It installs the package into a venv, creates a non-root `appuser`, and uses `tradingagents` as the entrypoint.

`docker-compose.yml` defines:
- `tradingagents`: interactive container, `.env`, persistent `tradingagents_data` volume.
- `ollama`: optional local Ollama service behind the `ollama` profile.
- `tradingagents-ollama`: TradingAgents service configured for the Ollama profile.

One issue: compose sets `LLM_PROVIDER=ollama`, while the current config override map expects `TRADINGAGENTS_LLM_PROVIDER`; unless the CLI maps this elsewhere, this env var may not affect `DEFAULT_CONFIG`.

## Architecture

### Main Modules

- `tradingagents/graph/trading_graph.py`: main orchestrator class, LLM setup, graph compile, propagation, logging, decision memory.
- `tradingagents/graph/setup.py`: builds the LangGraph state graph and edges.
- `tradingagents/graph/conditional_logic.py`: routes tool loops, bull/bear debate loops, and risk debate loops.
- `tradingagents/graph/propagation.py`: creates initial state and graph invocation args.
- `tradingagents/graph/signal_processing.py`: parses final portfolio rating deterministically.
- `tradingagents/graph/checkpointer.py`: optional SQLite-backed LangGraph checkpointing.
- `tradingagents/agents/**`: agent node factories and prompts.
- `tradingagents/agents/schemas.py`: Pydantic schemas for structured Research Manager, Trader, and Portfolio Manager output.
- `tradingagents/agents/utils/**`: LangChain tools, memory, rating parser, structured-output fallback.
- `tradingagents/dataflows/**`: yfinance, Alpha Vantage, StockTwits, Reddit, and routing logic.
- `tradingagents/llm_clients/**`: provider abstraction and model/provider quirks.
- `cli/**`: terminal UI, provider/model selection, stats display, report saving.
- `tests/**`: pytest suite.

### Frameworks And Dependencies

Core runtime:
- Python `>=3.10`.
- LangGraph for state-machine orchestration.
- LangChain Core plus provider integrations.
- Pydantic for structured output schemas.
- yfinance, stockstats, pandas for market and indicator data.
- requests/parsel for scraping/API-style data collection.
- Typer, Rich, Questionary for CLI.
- langgraph-checkpoint-sqlite for checkpoint persistence.

Notable declared dependency: `redis>=6.2.0`, but the inspected code did not show active Redis use.

## Workflow

The graph flow in `GraphSetup.setup_graph()` is:

1. `START`
2. Selected analysts, in configured order:
   - `Market Analyst`
   - `Sentiment Analyst` using the legacy wire key `social`
   - `News Analyst`
   - `Fundamentals Analyst`
3. Each tool-calling analyst loops:
   - analyst node
   - relevant `ToolNode`
   - same analyst until no tool calls remain
   - message-clear node to shrink state
4. `Bull Researcher`
5. `Bear Researcher`
6. Repeat bull/bear until `2 * max_debate_rounds`
7. `Research Manager`
8. `Trader`
9. `Aggressive Analyst`
10. `Conservative Analyst`
11. `Neutral Analyst`
12. Repeat risk debate until `3 * max_risk_discuss_rounds`
13. `Portfolio Manager`
14. `END`

Default debate settings are conservative: `max_debate_rounds = 1`, `max_risk_discuss_rounds = 1`, `max_recur_limit = 100`, and `analyst_concurrency_limit = 1`.

## Agent Roles

### Market Analyst

Uses `get_stock_data` and `get_indicators`. The prompt asks it to select up to 8 complementary indicators from a fixed set:
- Moving averages: `close_50_sma`, `close_200_sma`, `close_10_ema`
- MACD: `macd`, `macds`, `macdh`
- Momentum: `rsi`
- Volatility: `boll`, `boll_ub`, `boll_lb`, `atr`
- Volume: `vwma`

It is instructed to call `get_stock_data` first, then `get_indicators`, and produce a detailed technical report with a Markdown summary table.

### Sentiment Analyst

This was redesigned in v0.2.5 to avoid fabricated social-media claims. It no longer relies on tool-calling. Instead it pre-fetches:
- Yahoo Finance news headlines from the last 7 days.
- StockTwits messages for the ticker.
- Reddit posts from `r/wallstreetbets`, `r/stocks`, and `r/investing`.

Those blocks are injected into the prompt before the LLM runs. The prompt asks for overall sentiment, source breakdown, divergences/alignments, catalysts/risks, data-quality caveats, and a summary table.

The legacy function `create_social_media_analyst()` remains as a deprecated alias for backward compatibility.

### News Analyst

Uses `get_news` and `get_global_news`. It analyzes ticker-specific and macro/global news over the recent period and produces actionable trading implications plus a Markdown summary table.

### Fundamentals Analyst

Uses:
- `get_fundamentals`
- `get_balance_sheet`
- `get_cashflow`
- `get_income_statement`

It focuses on company profile, basic financials, statements, financial history, and fundamental risks. For crypto mode, fundamentals may be unavailable.

### Bull Researcher

Reads all analyst reports and argues the constructive case. It emphasizes growth potential, competitive advantages, positive indicators, and direct rebuttal of bear arguments.

### Bear Researcher

Reads all analyst reports and argues the negative case. It emphasizes downside risks, competitive weakness, negative indicators, and direct rebuttal of bull arguments.

### Research Manager

Uses structured output when available. It evaluates the bull/bear debate and produces a `ResearchPlan`:
- `recommendation`: `Buy`, `Overweight`, `Hold`, `Underweight`, or `Sell`
- `rationale`
- `strategic_actions`

Its rendered markdown becomes `investment_plan`.

### Trader

Uses structured output when available. It reads `investment_plan` and emits a `TraderProposal`:
- `action`: `Buy`, `Hold`, or `Sell`
- `reasoning`
- optional `entry_price`
- optional `stop_loss`
- optional `position_sizing`

The rendered markdown preserves a backward-compatible `FINAL TRANSACTION PROPOSAL: **BUY/HOLD/SELL**` line.

### Risk Analysts

Three agents debate the trader proposal:
- Aggressive: argues for high-upside/high-risk execution.
- Conservative: argues for capital preservation and risk mitigation.
- Neutral: balances both sides.

They use the analyst reports plus the trader proposal and previous risk-debate history.

### Portfolio Manager

Uses structured output when available. It synthesizes risk debate, research plan, trader proposal, and optional memory lessons into a `PortfolioDecision`:
- `rating`: `Buy`, `Overweight`, `Hold`, `Underweight`, or `Sell`
- `executive_summary`
- `investment_thesis`
- optional `price_target`
- optional `time_horizon`

The rendered markdown is saved as `final_trade_decision`. `SignalProcessor` extracts the rating with deterministic parsing, not another LLM call.

## State Model

`AgentState` extends LangGraph `MessagesState` and carries:
- `company_of_interest`
- `asset_type`
- `trade_date`
- `sender`
- `market_report`
- `sentiment_report`
- `news_report`
- `fundamentals_report`
- `investment_debate_state`
- `investment_plan`
- `trader_investment_plan`
- `risk_debate_state`
- `final_trade_decision`
- `past_context`

`InvestDebateState` tracks bull/bear histories, full debate history, current response, judge decision, and count.

`RiskDebateState` tracks aggressive/conservative/neutral histories, full debate history, latest speaker, current response per risk persona, judge decision, and count.

Message-clear nodes remove accumulated messages and insert a minimal `HumanMessage("Continue")`, partly for Anthropic compatibility and partly to keep graph state smaller.

## Data Layer

TradingAgents exposes agent tools through `tradingagents/agents/utils/*_tools.py`, but routes implementation via `tradingagents/dataflows/interface.py`.

Categories:
- `core_stock_apis`: `get_stock_data`
- `technical_indicators`: `get_indicators`
- `fundamental_data`: `get_fundamentals`, `get_balance_sheet`, `get_cashflow`, `get_income_statement`
- `news_data`: `get_news`, `get_global_news`, `get_insider_transactions`

Vendors:
- `yfinance`
- `alpha_vantage`

Config supports category-level vendor choices through `data_vendors` and tool-level overrides through `tool_vendors`. If Alpha Vantage hits a rate limit, routing falls back to another available vendor for the method.

Additional non-routed sources:
- StockTwits fetcher for retail messages.
- Reddit fetcher for finance subreddit posts.

Default data-vendor config uses yfinance for core stock data, indicators, fundamentals, and news.

## LLM Provider Layer

`create_llm_client(provider, model, base_url, **kwargs)` dispatches to provider-specific clients.

Supported provider keys observed:
- `openai`
- `google`
- `anthropic`
- `xai`
- `deepseek`
- `qwen`
- `qwen-cn`
- `glm`
- `glm-cn`
- `minimax`
- `minimax-cn`
- `openrouter`
- `ollama`
- `azure`

OpenAI-compatible providers use `ChatOpenAI` wrappers. Native OpenAI uses the Responses API. Provider-specific handling includes:
- DeepSeek reasoning-content roundtrip.
- MiniMax `reasoning_split` only for capable models.
- Capability-aware structured-output method choice.
- Suppression of `tool_choice` for providers/models that reject it.
- Ollama base URL override via `OLLAMA_BASE_URL`.
- Separate env vars for region-specific Qwen/GLM/MiniMax endpoints.

The code has a model catalog and validator layer. Unknown models can warn while custom model IDs remain possible.

## Configuration

`DEFAULT_CONFIG` lives in `tradingagents/default_config.py`.

Important defaults:
- `results_dir`: `~/.tradingagents/logs`
- `data_cache_dir`: `~/.tradingagents/cache`
- `memory_log_path`: `~/.tradingagents/memory/trading_memory.md`
- `llm_provider`: `openai`
- `deep_think_llm`: `gpt-5.4`
- `quick_think_llm`: `gpt-5.4-mini`
- `backend_url`: `None`
- `checkpoint_enabled`: `False`
- `output_language`: `English`
- `max_debate_rounds`: `1`
- `max_risk_discuss_rounds`: `1`
- `analyst_concurrency_limit`: `1`
- `news_article_limit`: `20`
- `global_news_article_limit`: `10`
- `global_news_lookback_days`: `7`

Supported `TRADINGAGENTS_*` overrides include:
- `TRADINGAGENTS_LLM_PROVIDER`
- `TRADINGAGENTS_DEEP_THINK_LLM`
- `TRADINGAGENTS_QUICK_THINK_LLM`
- `TRADINGAGENTS_LLM_BACKEND_URL`
- `TRADINGAGENTS_OUTPUT_LANGUAGE`
- `TRADINGAGENTS_MAX_DEBATE_ROUNDS`
- `TRADINGAGENTS_MAX_RISK_ROUNDS`
- `TRADINGAGENTS_CHECKPOINT_ENABLED`
- `TRADINGAGENTS_BENCHMARK_TICKER`

Other path overrides:
- `TRADINGAGENTS_RESULTS_DIR`
- `TRADINGAGENTS_CACHE_DIR`
- `TRADINGAGENTS_MEMORY_LOG_PATH`

Provider API key env vars include:
- `OPENAI_API_KEY`
- `GOOGLE_API_KEY`
- `ANTHROPIC_API_KEY`
- `XAI_API_KEY`
- `DEEPSEEK_API_KEY`
- `DASHSCOPE_API_KEY`
- `DASHSCOPE_CN_API_KEY`
- `ZHIPU_API_KEY`
- `ZHIPU_CN_API_KEY`
- `MINIMAX_API_KEY`
- `MINIMAX_CN_API_KEY`
- `OPENROUTER_API_KEY`
- `ALPHA_VANTAGE_API_KEY`

Azure uses Azure-specific env vars such as deployment name and endpoint settings in its client path.

## Persistence And Recovery

### Decision Memory

The decision log is append-only Markdown. On each completed run:

1. `TradingAgentsGraph._run_graph()` stores the final decision in memory.
2. The entry is tagged pending: `[date | ticker | rating | pending]`.
3. On a later same-ticker run, pending entries are resolved before analysis.
4. Resolution fetches raw return and benchmark alpha over a holding window.
5. `Reflector` generates a one-paragraph reflection.
6. The memory log is atomically updated.
7. Recent same-ticker and cross-ticker lessons are injected into the Portfolio Manager prompt.

Benchmarks default by ticker suffix:
- `.NS`: `^NSEI`
- `.BO`: `^BSESN`
- `.T`: `^N225`
- `.HK`: `^HSI`
- `.L`: `^FTSE`
- `.TO`: `^GSPTSE`
- `.AX`: `^AXJO`
- empty/default: `SPY`

`benchmark_ticker` can override this.

### Checkpoint Resume

Checkpointing is opt-in. If `checkpoint_enabled` is true:
- The graph recompiles with a per-ticker `SqliteSaver`.
- Checkpoint DBs live under `~/.tradingagents/cache/checkpoints/<ticker>.db`.
- The thread ID is derived from ticker and trade date.
- Successful completion clears the checkpoint to avoid stale resumes.

This is designed for expensive long-running LLM workflows that may crash or be interrupted.

## Filesystem Safety

The project validates ticker strings before using them as filesystem path components. Allowed characters are letters, digits, `.`, `_`, `-`, and `^`, with a max length default of 32. Values consisting only of dots are rejected. This protects cache, checkpoint, and result paths against path traversal.

This hardening was explicitly called out as a v0.2.5 security fix.

## Testing

The pytest suite is non-trivial and mostly unit-oriented. Test files cover:
- Analyst execution and ticker-symbol handling.
- Structured-agent schemas, rendering, and fallback.
- Signal/rating parsing.
- Safe ticker path component validation.
- Ollama base URL behavior.
- Model validation and capabilities.
- MiniMax provider quirks.
- Memory log parsing, pending/resolved updates, and PM memory injection.
- Google API key handling.
- Env overrides.
- DeepSeek reasoning behavior.
- Dataflow config routing.
- Crypto asset mode.
- Checkpoint resume.
- API-key env mapping and CLI prompting.
- Anthropic effort settings.

`pyproject.toml` configures pytest with `tests` as the test path and markers for `unit`, `integration`, and `smoke`.

## Deployment Target

Primary target is local Python/CLI execution. Docker support exists for reproducible local/container use. There is no server process, web API, auth system, frontend app, or production database layer in the inspected code.

Operationally, it depends on:
- User-provided LLM API keys or local Ollama.
- Network access to market/news/social data sources.
- Local filesystem persistence under `~/.tradingagents/`.
- Optional Alpha Vantage API key for Alpha Vantage data paths.

## Auth And Security Model

There is no application-user authentication. Authentication means provider API keys. The CLI can prompt for a missing provider key, write it to `.env`, and set it in `os.environ` for the current process.

Security considerations:
- Financial/news/social data is placed into LLM prompts; prompt injection from fetched content is a realistic risk.
- The code mitigates ticker path traversal, but LLM tool calls still depend on safe tool boundaries.
- API keys in `.env` need normal local secret hygiene.
- The output is advisory/research text, not broker-executed orders.
- No sandboxing is apparent around network fetchers.

## Recent Evolution

Recent changelog and commit history show active work around:
- v0.2.5 release on 2026-05-11.
- Grounded Sentiment Analyst using Yahoo News, StockTwits, Reddit.
- GPT-5.5, Claude 4.7, Gemini 3.1, Qwen/GLM/MiniMax catalog refreshes.
- Region-specific providers for China/international endpoints.
- Env-var driven default config.
- Remote Ollama support.
- Configurable news limits and macro queries.
- Non-US benchmark mapping for alpha calculations.
- Multi-language output coverage.
- Structured output compatibility fixes for DeepSeek and MiniMax.
- Ticker suffix preservation and path-traversal hardening.
- Recent commits on 2026-05-17 for Anthropic effort gating, MiniMax reasoning split, sentiment route labels, crypto asset mode, and analyst execution planning/timing.

## Strengths

- Clear multi-agent decomposition that maps well to trading-desk roles.
- LangGraph gives explicit control flow, state, checkpointing, and tool loops.
- Provider abstraction is broad and handles several real provider quirks.
- Structured outputs on decision agents improve parseability.
- Signal extraction no longer needs an extra LLM call.
- Decision memory closes the loop with realized return/alpha and reflections.
- Recent sentiment redesign reduces hallucinated social-data risk.
- Ticker path validation addresses a concrete filesystem security issue.
- CLI is feature-rich for experimentation.
- Tests cover many regressions from real issue history.

## Limitations And Risks

- It is research software, not production trading infrastructure.
- No portfolio accounting, broker integration, order management, slippage, fills, compliance, or risk limits beyond LLM debate.
- Backtesting fidelity depends on data vendors and whether prompts/tools avoid look-ahead leakage. The changelog mentions prior fixes here, so this remains an area to audit carefully.
- LLM outputs can still be wrong, inconsistent, overconfident, or prompt-injected.
- Social/news scraping APIs may break or return sparse data.
- Costs can be high because each run uses multiple LLM calls, tool calls, and debates.
- Default analyst execution is sequential; `analyst_concurrency_limit` exists in planning/tracking code but graph setup inspected still wires analysts sequentially.
- Fundamentals are equity-centric and weak for crypto mode.
- Redis is declared but not visibly used, which may indicate leftover dependency surface.
- Docker compose may have an env-var mismatch for Ollama provider selection.

## Integration Notes For market-bot

TradingAgents is most useful as a research-decision engine, not an execution layer.

Potential integration patterns:
- Wrap `TradingAgentsGraph.propagate()` behind a job runner for scheduled ticker analysis.
- Store `final_state` JSON into the host app database for auditability.
- Parse `decision` as a coarse signal only, then apply separate deterministic risk controls.
- Keep broker execution outside TradingAgents.
- Use `checkpoint_enabled` for long/expensive analysis jobs.
- Use a fixed provider/model set for reproducibility; avoid floating model aliases.
- Use `TRADINGAGENTS_RESULTS_DIR`, `TRADINGAGENTS_CACHE_DIR`, and `TRADINGAGENTS_MEMORY_LOG_PATH` to keep artifacts inside the host app's data directory.
- Treat fetched external text as untrusted input and consider prompt-injection guardrails before any automated trading use.

## Open Questions For Deeper Evaluation

- Does `analyst_concurrency_limit` currently create true parallel analyst execution or only metadata/timing support?
- How robust are Reddit/StockTwits fetchers under rate limits, blocking, or source schema changes?
- Are yfinance and Alpha Vantage outputs normalized enough for consistent downstream prompts?
- How often do structured-output fallbacks occur across non-OpenAI providers?
- What is the true end-to-end token/cost profile for common depth settings?
- Can decision memory create feedback loops or overfit to short holding windows?
- Is crypto mode intentionally analysis-only, or should separate crypto-native data sources replace equity fundamentals?
- Should Docker compose use `TRADINGAGENTS_LLM_PROVIDER=ollama` instead of `LLM_PROVIDER=ollama`?

## Source Map

Primary references inspected:
- `README.md`
- `CHANGELOG.md`
- `pyproject.toml`
- `Dockerfile`
- `docker-compose.yml`
- `main.py`
- `cli/main.py`
- `cli/utils.py`
- `tradingagents/default_config.py`
- `tradingagents/graph/trading_graph.py`
- `tradingagents/graph/setup.py`
- `tradingagents/graph/conditional_logic.py`
- `tradingagents/graph/propagation.py`
- `tradingagents/graph/signal_processing.py`
- `tradingagents/graph/checkpointer.py`
- `tradingagents/graph/analyst_execution.py`
- `tradingagents/agents/analysts/*.py`
- `tradingagents/agents/researchers/*.py`
- `tradingagents/agents/risk_mgmt/*.py`
- `tradingagents/agents/managers/*.py`
- `tradingagents/agents/trader/trader.py`
- `tradingagents/agents/schemas.py`
- `tradingagents/agents/utils/*.py`
- `tradingagents/dataflows/interface.py`
- `tradingagents/dataflows/utils.py`
- `tradingagents/llm_clients/*.py`
- `tests/*.py`
