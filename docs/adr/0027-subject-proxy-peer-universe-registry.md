# ADR 0027: Subject Proxy Peer Universe Registry

## Status

Accepted

## Context

The `research <subject>` run needs segment/theme identity before it can emit scored
predictions. Raw prompt text would fragment history (`semis`, `chip stocks`, `semiconductors`),
while model-selected proxies would make scored prediction subjects nondeterministic.

ADR 0004 requires predictions to resolve from public observable data. A thematic research subject
therefore needs a single listed proxy before it can produce scored predictions. Context baskets can
help describe a subject, but they are not scoreable as one observable event in V1.

## Decision

Add a checked-in, provenance-stamped equity research subject registry. Each entry owns:

- a canonical `subjectKey`
- display name and aliases
- asset class
- representative instruments with source provenance
- an optional single listed ETF prediction proxy with source provenance

Resolution is deterministic and local. The model may ask for a subject, but the code resolves it
only against the registry. If a subject does not resolve, or resolves to an entry without a single
listed ETF proxy, the later `research` run may still produce a report but emits zero predictions and
discloses the proxy gap.

For V1, prediction proxies must be single listed ETFs. Checked-in baskets and representative stocks
support context only; they do not make a subject prediction-resolvable.

## Consequences

Subject history and future cross-run intelligence can key off `subjectKey` instead of raw user text.
Scored thematic predictions remain observable through one listed proxy symbol. The registry is
unit-testable and does not require model calls or live provider lookups.

Rejected alternatives:

- Provider-sourced dynamic classification, which adds provider coverage dependency and
  nondeterminism to the scored path.
- Free model selection of proxies, which violates Peer Universe discipline.
- Weighted-basket prediction support in V1, which would require new forecast DSL and resolver work.
