# ADR 0002: Native TypeScript/Bun Orchestration

## Status

Accepted

## Context

Existing research and trading frameworks are broader than the V1 scope.

## Decision

Use a small native TypeScript/Bun CLI with replaceable source adapters and a provider abstraction for OpenAI first, while keeping OpenAI-compatible local providers config-ready.

## Consequences

The codebase stays auditable and testable. Provider and source adapters can be replaced without rewriting orchestration.
