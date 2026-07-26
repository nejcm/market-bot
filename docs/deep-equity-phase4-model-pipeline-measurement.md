# Deep-equity Phase 4 model-pipeline measurement

Measured 2026-07-26 against the six checked-in deep-equity replay fixtures.

The accepted plan's token gate is a **median model-token estimate improvement
of at least 30%**. The measured median prompt-token reduction is **38.05%**, so
the gate passes.

`equity-nbis-deep` is the per-fixture outlier at **26.58%** after the
simplified prompt restored prior-calibration, prior-forecast-error, and
`resolvedInstrumentIdentity` evidence omitted by the first draft. This is not
a plan-gate failure. It is retained as Phase 5 regression input with a 25%
floor in `tests/deep-equity-evaluation.test.ts`.

The call budget holds for every fixture: three core stages
(`equity-analysis`, `critique`, `final-synthesis`) and four total calls.

| Fixture                                | Simplified prompt tokens | Legacy prompt tokens | Reduction |
| -------------------------------------- | -----------------------: | -------------------: | --------: |
| `equity-aapl-deep`                     |                   33,769 |               54,707 |    38.27% |
| `equity-nbis-deep`                     |                   57,985 |               78,981 |    26.58% |
| `equity-fpi-quarterly`                 |                   25,178 |               41,526 |    39.37% |
| `equity-fpi-ifrs-semiannual`           |                   25,117 |               41,908 |    40.07% |
| `equity-analysis-comprehensive`        |                   37,524 |               57,484 |    34.72% |
| `equity-analysis-estimated-suppressed` |                   35,027 |               56,346 |    37.84% |

These are cassette-replay estimates with stub model outputs. The
`equity-analysis` stage has no cassette entry and falls back to an empty
response, while legacy analysis-stage cassette entries are approximately 50
characters. The reductions are therefore driven almost entirely by
evidence-payload size; the prior-stage-transcript axis is not exercised.
The 26.58% NBIS result is not a precise live-model prediction in either
direction.

The plan's patch-only repair wording is superseded. The shipped repair returns
a complete parseable report through `buildPredictionRepairInstruction`;
patch-only output is incompatible with the report reader and can otherwise
produce a silently empty report while consuming both retries.
