import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataCassetteKey, type DataCassette } from "../tests/support/run-fixtures/data-cassette";
import type { FixtureMeta } from "../tests/support/run-fixtures";

interface CassetteEntry {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

interface SyntheticFpiProfile {
  readonly fixtureName: string;
  readonly symbol: string;
  readonly companyName: string;
  readonly cik: number;
  readonly taxonomy: "us-gaap" | "ifrs-full";
  readonly cadence: "quarterly" | "semiannual";
}

const FIXTURE_ROOT = join(import.meta.dir, "..", "tests", "fixtures", "runs");
const BASE_FIXTURE = join(FIXTURE_ROOT, "equity-aapl-deep");
const NOW = "2026-06-15T14:30:00.000Z";

function entry(payload: unknown): CassetteEntry {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function durationFact(
  form: "20-F" | "6-K",
  fy: number,
  fp: string,
  start: string,
  end: string,
  filed: string,
  value: number,
): Readonly<Record<string, unknown>> {
  return {
    start,
    end,
    val: value,
    accn: `0000000000-${String(fy).slice(-2)}-${fp.toLowerCase().replaceAll(/[^a-z0-9]/gu, "")}`,
    fy,
    fp,
    form,
    filed,
  };
}

function factsForProfile(profile: SyntheticFpiProfile): Readonly<Record<string, unknown>> {
  const annual = [
    durationFact("20-F", 2023, "FY", "2023-01-01", "2023-12-31", "2024-03-15", 1_000_000_000),
    durationFact("20-F", 2024, "FY", "2024-01-01", "2024-12-31", "2025-03-15", 1_200_000_000),
    durationFact("20-F", 2025, "FY", "2025-01-01", "2025-12-31", "2026-03-15", 1_500_000_000),
  ];
  const interim =
    profile.cadence === "quarterly"
      ? [
          durationFact("6-K", 2025, "Q1", "2025-01-01", "2025-03-31", "2025-05-10", 300_000_000),
          durationFact("6-K", 2026, "Q1", "2026-01-01", "2026-03-31", "2026-05-10", 420_000_000),
        ]
      : [
          durationFact("6-K", 2025, "H1", "2025-01-01", "2025-06-30", "2025-08-15", 650_000_000),
          durationFact("6-K", 2026, "H1", "2026-01-01", "2026-06-30", "2026-08-15", 820_000_000),
        ];
  const conceptNames =
    profile.taxonomy === "us-gaap"
      ? {
          revenue: "Revenues",
          grossProfit: "GrossProfit",
          operatingIncome: "OperatingIncomeLoss",
          netIncome: "NetIncomeLoss",
        }
      : {
          revenue: "Revenue",
          grossProfit: "GrossProfit",
          operatingIncome: "ProfitLossFromOperatingActivities",
          netIncome: "ProfitLoss",
        };
  const concepts = Object.entries(conceptNames).map(([key, concept], index) => [
    concept,
    {
      label: concept,
      description: `${profile.companyName} synthetic ${key}`,
      units: {
        USD: [...annual, ...interim].map((fact) => ({
          ...fact,
          val: Number(fact.val) * (1 - index * 0.15),
        })),
      },
    },
  ]);
  return {
    cik: profile.cik,
    entityName: profile.companyName,
    facts: { [profile.taxonomy]: Object.fromEntries(concepts) },
  };
}

function submissionsForProfile(profile: SyntheticFpiProfile): Readonly<Record<string, unknown>> {
  const interimReportDate = profile.cadence === "quarterly" ? "2026-03-31" : "2026-06-30";
  return {
    cik: String(profile.cik).padStart(10, "0"),
    entityType: "operating",
    sic: "7372",
    name: profile.companyName,
    tickers: [profile.symbol],
    exchanges: ["Nasdaq"],
    filings: {
      recent: {
        accessionNumber: ["0000000000-26-000002", "0000000000-26-000001"],
        filingDate: ["2026-08-15", "2026-03-15"],
        reportDate: [interimReportDate, "2025-12-31"],
        acceptanceDateTime: ["20260815120000", "20260315120000"],
        act: ["34", "34"],
        form: ["6-K", "20-F"],
        fileNumber: ["001-00000", "001-00000"],
        filmNumber: ["26000002", "26000001"],
        items: ["", ""],
        core_type: ["6-K", "20-F"],
        size: [120_000, 900_000],
        isXBRL: [1, 1],
        isInlineXBRL: [1, 1],
        primaryDocument: [
          `${profile.symbol.toLowerCase()}-2026-interim.htm`,
          `${profile.symbol.toLowerCase()}-2025-20f.htm`,
        ],
        primaryDocDescription: ["Interim financial report", "Annual report"],
      },
      files: [],
    },
  };
}

function modelCassette(symbol: string, companyName: string): Readonly<Record<string, unknown>> {
  const lower = symbol.toLowerCase();
  const report = {
    summary: `${companyName} synthetic FPI fixture replayed through current equity research stages.`,
    keyFindings: [
      {
        text: `${symbol} has deterministic market and verified close evidence.`,
        sourceIds: [`market-yahoo-equity-${lower}`, `verified-snapshot-${symbol}`],
      },
    ],
    bullCase: [],
    bearCase: [],
    risks: [
      {
        text: "Current structured SEC normalization does not support the fixture filing forms.",
        sourceIds: [`market-yahoo-equity-${lower}`],
      },
    ],
    catalysts: [],
    scenarios: [
      {
        name: "Reference",
        description: `${symbol} remains within the deterministic fixture evidence envelope.`,
        sourceIds: [`market-yahoo-equity-${lower}`],
      },
    ],
    dataGaps: ["Synthetic FPI inputs exercise unsupported current filing forms."],
    predictions: [],
  };
  return {
    entries: {
      "playbook-selection|fixture-quick": [{ content: '{"selections":[]}', tokenEstimate: 10 }],
      "specialist-analysis|fixture-quick": [
        {
          content: JSON.stringify({ analysis: `${symbol} specialist analysis` }),
          tokenEstimate: 20,
        },
      ],
      "critique|fixture-quick": [
        { content: JSON.stringify({ critique: `${symbol} critique` }), tokenEstimate: 20 },
      ],
      "final-synthesis|fixture-synthesis": [
        { content: JSON.stringify(report), tokenEstimate: 50 },
        { content: JSON.stringify(report), tokenEstimate: 50 },
      ],
      "instrument-evidence-analysis|fixture-quick": [
        {
          content: JSON.stringify({ analysis: `${symbol} instrument evidence` }),
          tokenEstimate: 20,
        },
      ],
      "market-behavior-analysis|fixture-quick": [
        { content: JSON.stringify({ analysis: `${symbol} market behavior` }), tokenEstimate: 20 },
      ],
    },
  };
}

async function syntheticFpiCassette(profile: SyntheticFpiProfile): Promise<DataCassette> {
  const base = await readJson<DataCassette>(join(BASE_FIXTURE, "data-cassette.json"));
  const entries: Record<string, CassetteEntry> = {};
  const lower = profile.symbol.toLowerCase();
  for (const [key, value] of Object.entries(base.entries)) {
    if (key.includes("symbols=AAPL")) {
      const payload = JSON.parse(value.body) as {
        quoteResponse: { result: Record<string, unknown>[] };
      };
      const quote = payload.quoteResponse.result[0] as Record<string, unknown>;
      quote.symbol = profile.symbol;
      quote.shortName = profile.companyName;
      quote.marketCap = 20_000_000_000;
      entries[key.replace("symbols=AAPL", `symbols=${profile.symbol}`)] = entry(payload);
      continue;
    }
    if (key.includes("finance/search?")) {
      entries[key.replace("q=AAPL", `q=${profile.symbol}`)] = entry({
        news: [
          {
            title: `${profile.companyName} fixture headline`,
            link: `https://example.com/${lower}-fixture`,
            publisher: "Example News",
            providerPublishTime: 1_781_530_200,
          },
        ],
      });
      continue;
    }
    if (key === "GET  https://www.sec.gov/files/company_tickers.json") {
      entries[key] = entry({
        0: { cik_str: profile.cik, ticker: profile.symbol, title: profile.companyName },
      });
      continue;
    }
    if (key.includes("companyfacts/CIK0000320193")) {
      const cik = String(profile.cik).padStart(10, "0");
      entries[key.replace("CIK0000320193", `CIK${cik}`)] = entry(factsForProfile(profile));
      continue;
    }
    if (key.includes("submissions/CIK0000320193")) {
      const cik = String(profile.cik).padStart(10, "0");
      entries[key.replace("CIK0000320193", `CIK${cik}`)] = entry(submissionsForProfile(profile));
      continue;
    }
    if (key.includes("finance/chart/AAPL")) {
      entries[key.replace("chart/AAPL", `chart/${profile.symbol}`)] = value;
      continue;
    }
    if (key.includes("symbols=SPY%2CQQQ%2CIWM%2CDIA%2C%5EVIX%2C%5EVIX3M")) {
      entries[key] = value;
    }
  }
  return { entries };
}

async function writeSyntheticFpi(profile: SyntheticFpiProfile): Promise<void> {
  const dir = join(FIXTURE_ROOT, profile.fixtureName);
  await mkdir(dir, { recursive: true });
  const meta: FixtureMeta = {
    now: NOW,
    argv: ["equity", profile.symbol, "--deep"],
    quickModel: "fixture-quick",
    synthesisModel: "fixture-synthesis",
    challengerModels: [],
    secUserAgent: "market-bot fixture replay contact@example.invalid",
    webGatherDisabled: true,
    evidenceRequestOptions: { maxRounds: 1, maxToolCalls: 1, sourceBudget: 8 },
    webGatherOptions: { maxRounds: 0, maxToolCalls: 0, sourceBudget: 0 },
  };
  await writeJson(join(dir, "meta.json"), meta);
  await writeJson(join(dir, "data-cassette.json"), await syntheticFpiCassette(profile));
  await writeJson(
    join(dir, "llm-cassette.json"),
    modelCassette(profile.symbol, profile.companyName),
  );
}

async function addCassetteEntry(
  cassette: { entries: Record<string, CassetteEntry> },
  url: string,
  payload: unknown,
): Promise<void> {
  cassette.entries[await dataCassetteKey(url)] = entry(payload);
}

async function writeComprehensiveFixture(): Promise<void> {
  const fixtureName = "equity-analysis-comprehensive";
  const dir = join(FIXTURE_ROOT, fixtureName);
  await mkdir(dir, { recursive: true });
  const cassette = await readJson<{ entries: Record<string, CassetteEntry> }>(
    join(BASE_FIXTURE, "data-cassette.json"),
  );
  await addCassetteEntry(
    cassette,
    "https://finnhub.io/api/v1/company-news?symbol=AAPL&from=2026-05-16&to=2026-06-15&token=fixture-token",
    [
      {
        id: 1,
        headline: "Apple fixture provider update",
        source: "Fixture Wire",
        summary: "Deterministic current provider evidence.",
        url: "https://example.com/apple-provider-update",
        datetime: 1_781_530_200,
      },
    ],
  );
  await addCassetteEntry(
    cassette,
    "https://finnhub.io/api/v1/calendar/earnings?symbol=AAPL&from=2026-03-17&to=2026-09-13&token=fixture-token",
    {
      earningsCalendar: [
        {
          symbol: "AAPL",
          date: "2026-07-10",
          hour: "amc",
          epsEstimate: 1.72,
          revenueEstimate: 98_000_000_000,
        },
      ],
    },
  );
  await addCassetteEntry(
    cassette,
    "https://finnhub.io/api/v1/stock/dividend?symbol=AAPL&from=2026-03-17&to=2026-09-13&token=fixture-token",
    [],
  );
  await addCassetteEntry(
    cassette,
    "https://finnhub.io/api/v1/stock/split?symbol=AAPL&from=2026-03-17&to=2026-09-13&token=fixture-token",
    [],
  );
  await addCassetteEntry(
    cassette,
    "https://api.tradier.com/v1/markets/options/expirations?symbol=AAPL&includeAllRoots=true",
    { expirations: { date: ["2026-07-10", "2026-07-17", "2026-08-21"] } },
  );
  await addCassetteEntry(
    cassette,
    "https://api.tradier.com/v1/markets/options/chains?symbol=AAPL&expiration=2026-07-17&greeks=true",
    {
      options: {
        option: [
          {
            strike: 200,
            option_type: "call",
            bid: 3.8,
            ask: 4.2,
            greeks: { mid_iv: 0.31 },
          },
          {
            strike: 200,
            option_type: "put",
            bid: 2.8,
            ask: 3.2,
            greeks: { mid_iv: 0.33 },
          },
        ],
      },
    },
  );
  const baseMeta = await readJson<FixtureMeta>(join(BASE_FIXTURE, "meta.json"));
  await writeJson(join(dir, "meta.json"), {
    ...baseMeta,
    configuredProviders: ["finnhub", "tradier"],
  });
  await writeJson(join(dir, "data-cassette.json"), cassette);
  const baseLlm = await readJson<{
    entries: Record<string, { content: string; tokenEstimate: number }[]>;
  }>(join(BASE_FIXTURE, "llm-cassette.json"));
  const finalEntries = baseLlm.entries["final-synthesis|fixture-synthesis"] as {
    content: string;
    tokenEstimate: number;
  }[];
  const report = JSON.parse(finalEntries[0]?.content ?? "{}") as Record<string, unknown>;
  report.keyFindings = [
    ...(Array.isArray(report.keyFindings) ? report.keyFindings : []),
    {
      text: "The fixture includes a provider-estimated earnings event and options reference bar.",
      sourceIds: ["extended-finnhub-events-aapl", "extended-tradier-earnings-implied-move-aapl"],
    },
  ];
  report.predictions = [
    {
      id: "aapl-earnings-direction",
      kind: "earnings-direction",
      subject: "AAPL",
      measurableAs: "earningsReturn(AAPL, 2026-07-10, +1) > 0",
      horizonTradingDays: 1,
      probability: 0.58,
      sourceIds: ["extended-finnhub-events-aapl"],
    },
    {
      id: "aapl-earnings-move",
      kind: "earnings-move",
      subject: "AAPL",
      measurableAs: "abs(earningsReturn(AAPL, 2026-07-10, +1)) > 0.035",
      horizonTradingDays: 1,
      probability: 0.55,
      sourceIds: ["extended-finnhub-events-aapl", "extended-tradier-earnings-implied-move-aapl"],
    },
  ];
  report.extras = {
    earningsSetup: {
      expectationBar: [
        {
          text: "The deterministic fixture records the provider estimate and options reference bar.",
          sourceIds: [
            "extended-finnhub-events-aapl",
            "extended-tradier-earnings-implied-move-aapl",
          ],
        },
      ],
    },
  };
  baseLlm.entries["final-synthesis|fixture-synthesis"] = [
    { content: JSON.stringify(report), tokenEstimate: 70 },
    { content: JSON.stringify({ predictions: [] }), tokenEstimate: 10 },
  ];
  await writeJson(join(dir, "llm-cassette.json"), baseLlm);
}

async function normalizeNbisModelCassette(): Promise<void> {
  const dir = join(FIXTURE_ROOT, "equity-nbis-deep");
  const meta = await readJson<FixtureMeta>(join(dir, "meta.json"));
  await writeJson(join(dir, "meta.json"), {
    ...meta,
    quickModel: "fixture-quick",
    synthesisModel: "fixture-synthesis",
  });
  await writeJson(join(dir, "llm-cassette.json"), modelCassette("NBIS", "Nebius Group N.V."));
  const cassettePath = join(dir, "data-cassette.json");
  const cassette = await readJson<{ entries: Record<string, CassetteEntry> }>(cassettePath);
  for (const [key, value] of Object.entries(cassette.entries)) {
    if (!key.includes("finance/quote") || !key.includes("symbols=NBIS")) {
      continue;
    }
    const payload = JSON.parse(value.body) as {
      quoteResponse?: { result?: Record<string, unknown>[] };
    };
    for (const quote of payload.quoteResponse?.result ?? []) {
      delete quote.averageAnalystRating;
    }
    cassette.entries[key] = entry(payload);
  }
  await writeJson(cassettePath, cassette);
}

await writeSyntheticFpi({
  fixtureName: "equity-fpi-quarterly",
  symbol: "FPIQ",
  companyName: "Fixture Quarterly FPI N.V.",
  cik: 9_000_001,
  taxonomy: "us-gaap",
  cadence: "quarterly",
});
await writeSyntheticFpi({
  fixtureName: "equity-fpi-ifrs-semiannual",
  symbol: "IFRSSA",
  companyName: "Fixture IFRS Semiannual plc",
  cik: 9_000_002,
  taxonomy: "ifrs-full",
  cadence: "semiannual",
});
await writeComprehensiveFixture();
await normalizeNbisModelCassette();
