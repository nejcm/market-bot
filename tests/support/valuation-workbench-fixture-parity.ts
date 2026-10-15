import { expect } from "bun:test";
import {
  parseYahooChartOhlcv,
  classifyLatestSession,
  readYahooRegularSession,
} from "../../src/sources/yahoo";
import { fetchYahooFxClosesOnOrBefore } from "../../src/sources/yahoo-fx";
import type { BuildValuationWorkbenchInput } from "../../src/sources/extended-evidence/valuation-workbench";
import { verifiedMarketSnapshotSourceId } from "../../src/sources/verified-market-snapshot";
import { buildValuationWorkbench as legacyWorkbench } from "./valuation-workbench-legacy/valuation-workbench";
import { assertWorkbenchParity } from "./valuation-workbench-parity";
import { loadFixture, type RunFixtureResult, type FixtureMeta } from "./run-fixtures";
import { makeReplayFetch } from "./run-fixtures/data-cassette";

export async function assertWorkbenchFixtureParity(
  result: RunFixtureResult,
  meta: FixtureMeta,
  name: string,
): Promise<void> {
  const collected = result.collectedSources;
  const artifact = collected.valuationWorkbench;
  expect(
    artifact,
    "equity collection must publish a workbench even without statements",
  ).toBeDefined();
  const raw = collected.rawSnapshots.find(({ adapter }) => adapter === "yahoo-verified-chart");
  const parsed =
    raw === undefined ? [] : parseYahooChartOhlcv(raw.payload, meta.now.slice(0, 10)).bars;
  const last = parsed.at(-1);
  const verdict =
    raw === undefined || last === undefined
      ? undefined
      : classifyLatestSession(readYahooRegularSession(raw.payload), last.date, raw.fetchedAt);
  const input: BuildValuationWorkbenchInput = {
    symbol: artifact!.symbol,
    generatedAt: meta.now,
    ...(collected.financialStatements === undefined
      ? {}
      : { financialStatements: collected.financialStatements }),
    ...(collected.valuationComps === undefined ? {} : { valuationComps: collected.valuationComps }),
    priceHistory:
      collected.verifiedMarketSnapshot === undefined
        ? []
        : verdict?.status === "in-progress"
          ? parsed.slice(0, -1)
          : parsed,
    ...(collected.verifiedMarketSnapshot === undefined
      ? {}
      : { priceSourceId: verifiedMarketSnapshotSourceId(artifact!.symbol) }),
    ...(collected.resolvedInstrumentIdentity?.quoteCurrency === undefined
      ? {}
      : { quoteCurrency: collected.resolvedInstrumentIdentity.quoteCurrency }),
    ...(collected.extendedEvidence === undefined
      ? {}
      : { extendedEvidence: collected.extendedEvidence }),
  };
  const initial = legacyWorkbench(input);
  const fixture = await loadFixture(name);
  const fx =
    initial.quoteCurrency === null ||
    initial.reportingCurrency === null ||
    initial.quoteCurrency === initial.reportingCurrency
      ? {}
      : (
          await fetchYahooFxClosesOnOrBefore(
            initial.quoteCurrency,
            initial.reportingCurrency,
            initial.historicalMultiples.observations.flatMap(({ price }) =>
              price === null ? [] : [price.sessionDate],
            ),
            makeReplayFetch(fixture.dataCassette, fixture.dir),
          )
        ).closesByRequestedDate;
  const counts = assertWorkbenchParity(
    input,
    artifact!,
    collected.metricSections ?? [],
    collected.sourceGaps,
    fx,
  );
  process.stdout.write(
    `P8 fixture ${name} ${JSON.stringify(counts)} observations=${initial.historicalMultiples.observations.length} gaps=${collected.sourceGaps.filter(({ source }) => source.startsWith("valuation-workbench-")).length} material=${collected.sourceGaps.filter(({ source, triage }) => source.startsWith("valuation-workbench-") && triage === "material").length}\n`,
  );
}
