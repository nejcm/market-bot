# ADR 0001: Research-Only Boundary

## Status

Accepted

## Context

Market Bot V1 produces financial-market research artifacts. The system must not become a trading bot, portfolio manager, or execution assistant.

## Decision

Reports must include a standard research-only note and must not emit buy/sell/hold conclusions, position sizing, execution instructions, or portfolio-change language.

## Consequences

Safety checks are part of report validation and tests. Future alpha or decision layers must remain separate from V1 research generation.
