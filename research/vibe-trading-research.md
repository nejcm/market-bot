# Vibe-Trading Research Brief

Source: https://github.com/HKUDS/Vibe-Trading  
Inspected commit: `76629e8628ba0662a35acf8ba1ecabfb45bfa2ac`  
Commit date: 2026-05-18 16:10:36 +0800  
Package: `vibe-trading-ai` `0.1.8`  
License: MIT  

## Executive Summary

Vibe-Trading is an open-source, natural-language finance research agent. It turns user prompts into tool-backed market research, strategy code, backtests, reports, alpha-factor benchmarks, document analysis, and multi-agent research workflows.

It is not a live-trading bot. The repo repeatedly frames it as a research, simulation, and backtesting workspace. Its main value is giving an LLM a controlled finance toolchain: data loaders, backtest engines, file/document/web readers, finance skills, persistent memory, and a UI/API/MCP surface.

At the inspected commit, the project is a Python 3.11+ backend with a React 19/Vite frontend. The backend exposes:

- CLI: `vibe-trading`
- API server: `vibe-trading serve`
- MCP server: `vibe-trading-mcp`
- Web UI served from FastAPI or Vite dev server
- 75 finance skills
- 29 swarm team presets
- 22 MCP tools
- 31 local auto-discovered agent tools in the internal registry
- 452 Alpha Zoo factors across four factor libraries
- 82 Python test files

## What It Is

Vibe-Trading is a tool-using finance agent framework. Its core loop is a ReAct-style LLM agent that decides which finance skill to load, which tools to run, what files to write, and when to backtest or report results.

The agent can:

- Answer market research questions with web, document, and data-source grounding.
- Generate `SignalEngine` strategy code from natural language.
- Write backtest config/code into a run directory.
- Execute built-in backtest engines.
- Return metrics, artifacts, run cards, traces, charts, and exports.
- Analyze broker trade journals.
- Extract a "Shadow Account" strategy from profitable historical trades.
- Run multi-market shadow backtests.
- Run multi-agent swarm research teams.
- Browse and benchmark a large library of pre-built quant alpha factors.
- Persist memories and search old sessions.
- Expose its capabilities to external agent clients via MCP.
- Load external MCP tools into its own agent registry.

## What It Does

### Natural-Language Research

Users interact through CLI, Web UI, API sessions, or MCP. A prompt enters the agent loop, which builds a system prompt containing tool descriptions, summarized finance skills, workspace state, memory context, and routing rules. The LLM then emits tool calls until it reaches a final answer.

The default workflow is:

1. Load relevant skill documentation.
2. Use tools to fetch data, read files/web pages, or write strategy files.
3. Run backtest/analysis tools.
4. Read generated artifacts.
5. Return metrics and report content.

The agent is explicitly instructed to ask for missing critical info such as assets, dates, and strategy type instead of guessing.

### Backtesting

The backtest path expects a run directory with:

- `config.json`
- `code/signal_engine.py`

The generated `SignalEngine` class must expose strategy signal generation. `backtest.runner` validates config, validates the generated source file before import, loads the matching market data, selects an engine, runs a bar-by-bar backtest, and writes artifacts.

Supported sources:

- `tushare`: China A-shares, futures, funds, macro; token required for best coverage.
- `akshare`: free fallback for A-shares, HK/US, futures, forex, macro.
- `yfinance`: HK/US equities.
- `okx`: crypto.
- `ccxt`: crypto across many exchanges.
- `futu`: HK/A-share via local FutuOpenD.
- `auto`: market detection plus fallback chains.

Supported engine families include:

- China A-share
- China futures
- Global futures
- Global equities
- Crypto
- Forex
- Options portfolio
- Composite cross-market engine

Backtest output includes metrics, trades, equity curves, benchmark comparison, by-symbol stats, exit-reason stats, and optional validation results. Validation can include Monte Carlo, bootstrap confidence intervals, and walk-forward analysis.

### Alpha Zoo

Version `0.1.8` adds a major Alpha Zoo subsystem:

- `qlib158`: 155 Python files in repo count, documented as 154 alphas in README/changelog.
- `alpha101`: 102 Python files in repo count, documented as 101 alphas.
- `gtja191`: 192 Python files in repo count, documented as 191 alphas.
- `academic`: 7 Python files in repo count, documented as 6 factors.
- Total documented alphas: 452.

It provides:

- CLI: `vibe-trading alpha list/show/bench/compare/export-manifest`
- API routes: `/alpha/list`, `/alpha/{alpha_id}`, `/alpha/bench`, `/alpha/bench/{job_id}/stream`
- Web UI page: `/alpha-zoo`
- Factor registry with AST metadata extraction and lazy compute.
- Purity/lookahead tests and CI grep gates.
- Bench runner producing IC/IR and alive/reversed/dead categorization.

The safety design matters: alpha modules are scanned with AST allowlists, lookahead is tested via future-row corruption, and network is blocked in factor tests via `pytest-socket`.

### Shadow Account

Shadow Account is the project's behavior-analysis feature. It starts from a user's broker journal, not from a generic strategy template.

Pipeline:

1. Parse broker export into normalized trade records.
2. Pair buy/sell trades using FIFO.
3. Keep profitable roundtrips.
4. Engineer journal-derived features such as holding days, PnL percent, entry hour, weekday, and market.
5. Cluster profitable roundtrips with KMeans.
6. Derive rules using decision-tree-style/heuristic extraction.
7. Render a strategy profile and generated `SignalEngine`.
8. Run a multi-market backtest on representative liquid baskets.
9. Attribute delta PnL versus real trades: missed signals, noise trades, early exits, late exits, overtrading.
10. Render HTML/PDF reports.
11. Optionally scan today's signals using deterministic OHLCV feature checks.

Supported Shadow Account market baskets:

- China A-share
- HK equities
- US equities
- Crypto

Important constraint: extraction requires at least five profitable roundtrips.

### Trade Journal Analysis

The journal tooling parses broker exports from:

- Tonghuashun
- Eastmoney
- Futu
- Generic CSV/Excel formats

It computes behavior diagnostics such as holding period, win rate, PnL ratio, drawdown, disposition effect, overtrading, momentum chasing, and anchoring.

### Multi-Agent Swarms

Swarm mode runs preset teams of workers in a DAG. The runtime:

- Builds a run from a YAML preset.
- Validates the DAG.
- Computes topological layers.
- Runs tasks in parallel within each layer and serially across layers.
- Persists task state, events, and reports.
- Supports cancellation.
- Grounds workers with fetched market data where possible.

There are 29 presets, including investment committee, global equities desk, crypto trading desk, earnings research desk, macro/rates/FX desk, quant strategy desk, technical analysis panel, risk committee, and global allocation committee.

Swarm use is gated in the agent prompt: it should only run when the user explicitly asks for a team, committee, or swarm workflow.

### Persistent Memory And Session Search

Vibe-Trading has two memory/search layers:

- File-backed persistent memory at `~/.vibe-trading/memory`.
- SQLite FTS5 session search at `~/.vibe-trading/sessions.db`.

Persistent memory stores Markdown files with frontmatter and a short `MEMORY.md` index. It supports cross-session auto-recall by keyword relevance.

Session storage itself is filesystem-backed:

```text
sessions/
  {session_id}/
    session.json
    messages.jsonl
    attempts/
      {attempt_id}/attempt.json
```

SQLite is only the search index, not the primary session store.

### MCP Support

Vibe-Trading supports MCP in two directions.

As an MCP server, it exposes 22 tools:

- `list_skills`
- `load_skill`
- `backtest`
- `factor_analysis`
- `analyze_options`
- `pattern_recognition`
- `get_market_data`
- `web_search`
- `read_url`
- `read_document`
- `read_file`
- `write_file`
- `analyze_trade_journal`
- `extract_shadow_strategy`
- `run_shadow_backtest`
- `render_shadow_report`
- `scan_shadow_signals`
- `list_swarm_presets`
- `run_swarm`
- `get_swarm_status`
- `get_run_result`
- `list_runs`

As an MCP client, the built-in agent can load tools from external stdio, SSE, or streamable HTTP MCP servers configured in `~/.vibe-trading/agent.json`. Remote tool names are prefixed as `mcp_<server>_<tool>`.

MCP v1 limits:

- Tools only; no resources/prompts.
- No hot reload.
- Remote MCP tools execute serially.
- Remote MCP tools are excluded from swarm worker registries.

## Architecture

### Top-Level Layout

```text
agent/       Python backend, CLI, API, MCP, tools, skills, backtests
frontend/    React 19 + Vite + TypeScript Web UI
wiki/        Public docs/wiki generation
tools/       Repo-level CI scripts
assets/      Images and badges
Dockerfile   Multi-stage frontend/backend image
docker-compose.yml
pyproject.toml
```

### Backend Frameworks And Libraries

Core backend stack:

- Python 3.11+
- FastAPI
- Uvicorn
- Pydantic v2
- LangChain / LangChain OpenAI
- LangGraph packages
- FastMCP
- pandas, numpy, scipy, scikit-learn
- DuckDB dependency present
- SQLite via Python stdlib for FTS5 session search
- Rich and prompt_toolkit for CLI/TUI
- ddgs for DuckDuckGo search
- document dependencies: python-docx, python-pptx, pypdfium2, Pillow, openpyxl
- report dependencies: Jinja2, matplotlib, WeasyPrint

Frontend stack:

- React 19
- TypeScript
- Vite 6
- React Router 7
- Zustand
- ECharts 6
- Tailwind CSS
- lucide-react
- react-markdown with GFM/highlight support

### Entry Points

Python package scripts:

- `vibe-trading = cli:main`
- `vibe-trading-mcp = mcp_server:main`

Primary files:

- `agent/cli.py`: interactive CLI, subcommands, provider login, alpha commands, serve delegation.
- `agent/api_server.py`: FastAPI app, session runtime, runs, upload, swarm, settings, SSE, static frontend.
- `agent/mcp_server.py`: FastMCP server and exported MCP tools.
- `agent/src/agent/loop.py`: ReAct agent loop.
- `agent/src/agent/context.py`: system prompt, tool/skill descriptions, memory injection.
- `agent/src/tools/__init__.py`: tool auto-discovery and registry construction.
- `agent/backtest/runner.py`: config validation, signal-engine import, loader/engine selection.

### Agent Loop

`AgentLoop` is the runtime core.

Key behavior:

- Creates or reuses a run directory under `agent/runs`.
- Saves request metadata.
- Builds messages with `ContextBuilder`.
- Streams model output through `ChatLLM`.
- Executes tool calls.
- Batches consecutive readonly tools in parallel with a thread pool.
- Executes write tools serially.
- Tracks successful non-repeatable tools to avoid duplicate calls.
- Emits events for the Web UI/SSE.
- Writes trace events to the run directory.
- Marks runs success/failure/cancelled.

Context management has five layers:

1. Microcompact old tool results.
2. Collapse long text blocks without an LLM call.
3. Auto-compact with structured LLM summary when token threshold is exceeded.
4. Explicit `compact` tool.
5. Iterative summary update.

Default token threshold is `40000`, configurable by `TOKEN_THRESHOLD`.

### Tool Registry

Local tools are auto-discovered by importing modules under `agent/src/tools` and collecting `BaseTool` subclasses. Tools can declare:

- `name`
- `description`
- JSON-schema `parameters`
- `repeatable`
- `is_readonly`
- `check_available()`

Shell tools are disabled unless the caller is local/trusted or explicitly enables them.

Representative local tools:

- Backtesting: `backtest`
- Factor/alpha: `factor_analysis`, `alpha_zoo`, `alpha_bench`
- Options: `options_pricing`
- Technical patterns: `pattern`
- File IO: `read_file`, `write_file`, `edit_file`
- Web/doc: `web_search`, `read_url`, `read_document`
- Memory/search: `remember`, `session_search`
- Hypotheses: `create_hypothesis`, `update_hypothesis`, `link_backtest`, `search_hypotheses`
- Skills: `load_skill`, `save_skill`, `patch_skill`, `delete_skill`, `skill_file`
- Swarm: `run_swarm`
- Shadow Account: `extract_shadow_strategy`, `run_shadow_backtest`, `render_shadow_report`, `scan_shadow_signals`
- Shell/background: `bash`, `background_run`, `check_background`

### Skills System

Skills are Markdown directories with `SKILL.md` files and frontmatter. The loader reads bundled skills from `agent/src/skills` and user skills from `~/.vibe-trading/skills/user`.

The system prompt includes only one-line skill descriptions. Full skill bodies are loaded on demand through `load_skill`, which is the project's progressive-disclosure pattern.

Categories include:

- Data source
- Strategy
- Analysis
- Asset class
- Crypto
- Flow
- Tool
- Risk analysis / other

The loader gives user-created skills precedence over bundled skills with the same name.

### LLM Providers

The provider layer wraps OpenAI-compatible chat APIs through LangChain. Supported provider configs include:

- OpenRouter
- OpenAI
- OpenAI Codex via ChatGPT OAuth
- DeepSeek
- Gemini
- Groq
- DashScope/Qwen
- Zhipu
- Moonshot/Kimi
- MiniMax
- Xiaomi MIMO
- Z.ai
- Ollama

The factory maps provider-specific env vars into `OPENAI_*` variables expected by LangChain.

It also has a custom `ChatOpenAIWithReasoning` class to preserve provider-specific reasoning fields such as `reasoning_content`/`reasoning` across invoke, stream, and multi-turn request serialization.

`.env` search order:

1. `~/.vibe-trading/.env`
2. `agent/.env`
3. current working directory `.env`

### API Server

FastAPI app metadata:

- Title: `Vibe-Trading API`
- Version: `5.0.0`
- Docs: `/docs`
- Redoc: `/redoc`

Main API areas:

- Runs: `/runs`, `/runs/{run_id}`, `/runs/{run_id}/code`, `/runs/{run_id}/pine`
- Sessions: `/sessions`, `/sessions/{id}`, messages, cancel, SSE events
- Upload: `/upload`
- Shadow reports: `/shadow-reports/{shadow_id}`
- Swarm: `/swarm/presets`, `/swarm/runs`, swarm SSE, cancel
- Alpha: `/alpha/list`, `/alpha/{id}`, `/alpha/bench`, bench SSE
- Settings: `/settings/llm`, `/settings/data-sources`
- Correlation: `/correlation`
- Health: `/health`

Session send-message flow:

1. `POST /sessions/{session_id}/messages`
2. `SessionService.send_message`
3. Append user message to JSONL
4. Create attempt
5. Schedule `_run_attempt`
6. Build registry and `AgentLoop`
7. Run in a bounded thread pool
8. Persist attempt result
9. Append assistant reply
10. Emit SSE events

### Frontend

The frontend has lazy-loaded routes:

- `/`
- `/agent`
- `/settings`
- `/runs/:runId`
- `/compare`
- `/correlation`
- `/alpha-zoo`
- `/alpha-zoo/bench`
- `/alpha-zoo/:alphaId`

The frontend API wrapper uses relative paths, so in production FastAPI can serve static files and API routes from one origin. In development, Vite proxies to the backend.

User-facing Web UI areas include chat/agent, run detail, compare, correlation heatmap, Alpha Zoo, and settings.

### Deployment

Dockerfile is multi-stage:

1. Build frontend with Node 20 slim.
2. Build Python 3.11 slim runtime.
3. Install Python deps from `agent/requirements.txt`.
4. Copy backend and built frontend.
5. Install package editable.
6. Create non-root `vibe` user.
7. Expose `8899`.
8. Health check `/health`.
9. Run `vibe-trading serve --host 0.0.0.0 --port 8899`.

Compose:

- Backend bound to `127.0.0.1:8899:8899` by default.
- Volumes for runs and sessions.
- Optional frontend profile using Node 20 and Vite on `5899`.

## Data Model And Persistence

Primary persistence is file-based:

- Runs: `agent/runs` or configured roots.
- Sessions: `agent/sessions` or Docker volume.
- Memory: `~/.vibe-trading/memory`.
- Session search index: `~/.vibe-trading/sessions.db`.
- Shadow reports: `~/.vibe-trading/shadow_reports`.
- Shadow run dirs: `~/.vibe-trading/shadow_runs`.

SQLite appears only for FTS5 search. DuckDB is a dependency, but the inspected core session/backtest paths do not use it as the primary database.

## Security Model

The repo has substantial hardening work.

API auth:

- If `API_AUTH_KEY` is set, sensitive endpoints require Bearer auth.
- If not set, sensitive endpoints allow loopback clients only.
- EventSource streams can pass API key via query string because native EventSource cannot set custom headers.
- Settings access is loopback-only when auth is disabled.

CORS:

- Credentialed wildcard CORS is rejected.
- Default origins are explicit localhost/127.0.0.1 dev origins.

Shell tools:

- Shell-capable tools are disabled for remote API sessions unless `VIBE_TRADING_ENABLE_SHELL_TOOLS=1`.
- Local CLI/trusted loopback can include them.

File/upload safety:

- Upload endpoint blocks executables, scripts, archives, templates, Dockerfiles, and similar dangerous file types.
- Document/journal readers are limited to allowed roots by default.
- Run directories have allowed-root validation.

Generated code:

- Backtest runner validates `signal_engine.py` AST before import.
- It rejects executable top-level statements, decorators, unsafe annotations, class-level executable statements, and non-literal defaults.

Alpha Zoo:

- AST purity gates block imports/calls associated with IO, networking, eval/exec/import, etc.
- Lookahead tests verify future rows do not affect probe results.
- CI grep gates reject unsafe YAML loading and certain artifact leaks.

Docker:

- Runtime runs as non-root user.
- Compose binds backend to host loopback by default.

Known risk surface:

- This is an LLM tool-agent that can write files and, under trusted modes, execute shell commands.
- External MCP configs can spawn subprocesses or call remote tools and are operator-trust features.
- LLM output can still generate bad strategies or misleading analysis.
- The project is research-only and should not be treated as trading advice or live execution infrastructure.

## Testing

Observed tests:

- 82 `agent/tests/test_*.py` files.
- Additional factor-specific tests under `agent/tests/factors`.
- Pytest config in `pyproject.toml`.
- Test path: `agent/tests`.
- Python path: `agent`.
- Markers: `unit`, `integration`.
- Dev dependencies: `pytest`, `pytest-cov`, `pytest-socket`.

Coverage areas visible from filenames and changelog:

- Agent loop terminal states
- CLI init and memory commands
- Config handling
- Backtest engines and runner security
- Data loaders: AKShare, OKX, CCXT, Futu, Tushare fundamentals
- Market detection
- MCP server/client integrations
- Upload and web/document reader security
- Tool registry security
- Redaction and path safety
- Shadow account extraction/codegen/scanning
- Swarm store/runtime/output/grounding/token tracking
- Settings APIs
- Alpha purity/lookahead/network isolation

## Strengths

- Broad finance scope with concrete tools, not just prompt templates.
- Good separation between agent loop, tools, skills, backtest engines, loaders, API, and frontend.
- Progressive skill loading keeps the prompt smaller while preserving domain guidance.
- Auto-discovered tool registry makes local tools easy to extend.
- Backtest code import is guarded with AST validation.
- Data fallback design reduces setup friction.
- Strong local-dev security defaults compared with many hobby agent repos.
- MCP support makes the system usable both as a tool server and as an agent that can consume external tools.
- Alpha Zoo and benchmark tooling give it a real quant-research surface.
- File-backed state is simple to inspect/debug.
- Docker image avoids root runtime.

## Weaknesses And Limitations

- Scope is very large for a `0.1.x` project; quality likely varies by feature.
- LLM behavior is highly provider/model dependent. The README explicitly warns small/cheap models may fail to use tools properly.
- Many finance claims depend on external data sources that can be unstable, rate-limited, region-blocked, or schema-changing.
- No live execution layer, which is intentional but important.
- Backtesting realism depends on the engine assumptions, liquidity, slippage, fees, market rules, and data quality.
- Shadow Account extraction relies on journal-derived features and requires enough profitable roundtrips; it is not magic strategy discovery.
- File-based stores are simple but may not scale cleanly for multi-user or hosted production usage.
- Remote API deployment requires careful auth, CORS, shell-tool, and file-root configuration.
- MCP client mode is tools-only and serial; not a full MCP surface.
- Swarm workers do not receive external MCP tools in v1.
- Some README counts and actual file counts differ by one because package directories include `__init__.py` or helper files.

## How To Run

### Local install

```bash
pip install vibe-trading-ai
vibe-trading init
vibe-trading run -p "Backtest BTC-USDT 20/50 MA strategy for 2024"
```

### API/Web

```bash
vibe-trading serve --port 8899
```

Open:

```text
http://localhost:8899
http://localhost:8899/docs
```

### Dev frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend defaults to Vite and proxies API calls to backend.

### Docker

```bash
docker compose up --build
```

Backend binds to:

```text
127.0.0.1:8899
```

### MCP server

```bash
vibe-trading-mcp
vibe-trading-mcp --transport sse
```

## Environment Variables

Important variables:

- `LANGCHAIN_PROVIDER`
- `LANGCHAIN_MODEL_NAME`
- `<PROVIDER>_API_KEY`
- `<PROVIDER>_BASE_URL`
- `LANGCHAIN_TEMPERATURE`
- `LANGCHAIN_REASONING_EFFORT`
- `TIMEOUT_SECONDS`
- `MAX_RETRIES`
- `TUSHARE_TOKEN`
- `CCXT_EXCHANGE`
- `FUTU_HOST`
- `FUTU_PORT`
- `API_AUTH_KEY`
- `CORS_ORIGINS`
- `ENABLE_SESSION_RUNTIME`
- `VIBE_TRADING_ENABLE_SHELL_TOOLS`
- `VIBE_TRADING_ALLOWED_FILE_ROOTS`
- `VIBE_TRADING_ALLOWED_RUN_ROOTS`
- `TOKEN_THRESHOLD`
- `SWARM_WORKER_TIMEOUT`
- `SWARM_MAX_WORKERS`
- `ALLOW_SESSION_MCP_SERVERS`

## Suggested Mental Model

Think of Vibe-Trading as a local finance research operating system:

- The LLM is the planner and narrator.
- Skills are domain playbooks.
- Tools are controlled capabilities.
- Runs are reproducible workspaces.
- Backtest engines are the simulation kernel.
- Loaders are market data adapters.
- Sessions and memory are continuity layers.
- The Web UI/API/MCP are interaction surfaces.
- Swarms are structured multi-agent workflows.
- Alpha Zoo is a prebuilt factor research library.

## Bottom Line

Vibe-Trading is a serious attempt at a finance-specific agent workspace, not just a chatbot wrapper. Its core design is coherent: natural language routes into skills, tools, generated strategy files, data loaders, backtest engines, reports, and persistent artifacts. The repo has enough security and testing scaffolding to show active hardening, but its breadth and early version mean it should be treated as a research tool that needs verification on every important output.

