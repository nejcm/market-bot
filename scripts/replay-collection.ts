// Offline source-collection replay of a fixture or `<run>/replay`: no model synthesis, prints debt facts and notes.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withRunCapture } from "../src/replay/capture";
import { countCassetteMisses, makeReplayFetch } from "../src/replay/data-cassette";
import { makeReplayProvider } from "../src/replay/llm-cassette";
import { withReplaySession } from "../src/replay/session";
import {
  commandWithResolvedResearchSubject,
  resolveResearchSubject,
} from "../src/research/research-subject-identity";
import { collectSources } from "../src/sources/collector";
import { financialStatementFacts } from "../src/sources/extended-evidence/financial-statement-selection";
import { EVALS_ROOT } from "../tests/support/run-fixtures/eval";
import {
  createFixtureConfig,
  fixtureCommand,
  loadFixture,
} from "../tests/support/run-fixtures/index";

const args = process.argv.slice(2);
const positional = args.filter((argument) => !argument.startsWith("--"));
const fixtureName = positional.length === 1 ? positional[0] : undefined;
const labelFlag = args.find((argument) => argument.startsWith("--label="));
const disabled = args.includes("--tagged-zero-debt-disable");
if (fixtureName === undefined || labelFlag === undefined) {
  throw new Error(
    "Usage: bun run scripts/replay-collection.ts <fixture-name | <run>/replay> --label=<fresh> [--tagged-zero-debt-disable]",
  );
}
const outDir = join(EVALS_ROOT, labelFlag.slice("--label=".length));
await mkdir(outDir);
const fixture = await loadFixture(fixtureName);
const config = createFixtureConfig(fixture.meta, join(outDir, "runs"));
const httpMisses: string[] = [];
const fetchImpl = countCassetteMisses(
  makeReplayFetch(fixture.dataCassette, fixture.dir),
  httpMisses,
);
const rawCommand = fixtureCommand(fixture.meta);
const resolvedSubject = resolveResearchSubject(rawCommand);
const command = commandWithResolvedResearchSubject(rawCommand, resolvedSubject);
const now = new Date(fixture.meta.now);
const failures: string[] = [];
const { collected } = await withReplaySession(
  {
    mode: "replay",
    state: fixture.state ?? { values: {} },
    indexes: new Map(),
    failures,
    offline: true,
  },
  () =>
    withRunCapture(
      { command, config, provider: makeReplayProvider(fixture.llmCassette), now, fetchImpl },
      async (runtime) => ({
        artifacts: { runDir: outDir },
        collected: await collectSources(command, config.sourceOptions, {
          now,
          fetchImpl: runtime.fetchImpl,
          ...(resolvedSubject === undefined ? {} : { resolvedSubject }),
          ...(disabled || config.taggedZeroDebtDisabled === true
            ? { taggedZeroDebtDisabled: true }
            : {}),
          peerUniverse: {
            provider: runtime.provider,
            model: config.quickModel,
            cachePath: join(outDir, "peer-universe.json"),
          },
        }),
      }),
    ),
);
const statements = collected.financialStatements;
const summary = {
  httpMisses,
  failures,
  debt:
    statements === undefined
      ? []
      : financialStatementFacts(statements.statements.balanceSheet.debt).map(
          ({ periodEnd, value, concept, zeroBorrowingsQuote }) => ({
            periodEnd,
            value,
            concept,
            ...(zeroBorrowingsQuote === undefined ? {} : { zeroBorrowingsQuote }),
          }),
        ),
  debtNotes: [...(statements?.omissionNotes ?? []), ...(statements?.validationNotes ?? [])].filter(
    ({ seriesKey }) => seriesKey === "debt",
  ),
};
await Bun.write(join(outDir, "collection.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
