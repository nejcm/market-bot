# ADR 0035: Web Subject Profile across subject kinds

## Status

Accepted

## Context

ADR 0034 admitted low-trust cited web Sources for `equity --deep` company context. Broadening that subsystem to crypto and thematic research exposed that the old Web Company Profile schema, containment guard, and SEC-aware reuse rules were company-shaped.

## Decision

Generalize the sidecar to a version 2 Web Subject Profile keyed by `subjectKind` and `subjectId`, with fixed cited question sets for `company`, `crypto-asset`, and `theme`. Company profiles keep SEC-filing-aware reuse; crypto-asset and theme profiles use time-TTL reuse only. `market-overview` remains out of scope because it has no single Subject for strict containment.

## Consequences

Web evidence can now fill current-context gaps for `crypto --deep` and `research --deep` without changing prediction subjects or treating web text as authoritative. Strict subject-term containment and per-run `web_fetch` allowlisting reduce injection and scope-drift risk, but open-web content remains untrusted and capped as Extended Evidence.
