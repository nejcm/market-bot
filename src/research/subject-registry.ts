import type { AssetClass } from "../domain/types";

const SUBJECT_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,9}$/u;

export type ResearchSubjectAssetClass = Extract<AssetClass, "equity">;

export type ResearchSubjectInstrumentType = "listed-etf" | "listed-stock";

export interface ResearchSubjectSource {
  readonly sourceId: string;
  readonly title: string;
  readonly url?: string;
}

export interface ResearchSubjectInstrument {
  readonly symbol: string;
  readonly name?: string;
  readonly instrumentType: ResearchSubjectInstrumentType;
  readonly sourceIds: readonly string[];
}

export interface ResearchSubjectPredictionProxy {
  readonly symbol: string;
  readonly instrumentType: Extract<ResearchSubjectInstrumentType, "listed-etf">;
  readonly sourceIds: readonly string[];
}

export interface ResearchSubjectRegistryEntry {
  readonly subjectKey: string;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly assetClass: ResearchSubjectAssetClass;
  readonly representativeInstruments: readonly ResearchSubjectInstrument[];
  readonly predictionProxy?: ResearchSubjectPredictionProxy;
  readonly sources: readonly ResearchSubjectSource[];
}

export interface ResearchSubjectProxyResolution {
  readonly input: string;
  readonly normalizedInput: string;
  readonly status: "resolved" | "unresolved";
  readonly subject?: ResearchSubjectRegistryEntry;
  readonly predictionProxySymbol?: string;
  readonly canEmitPredictions: boolean;
  readonly reason: string;
}

export interface ResearchSubjectRegistryValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export const DEFAULT_RESEARCH_SUBJECT_REGISTRY: readonly ResearchSubjectRegistryEntry[] =
  validateDefaultRegistry([
    {
      subjectKey: "semiconductors",
      displayName: "Semiconductors",
      aliases: ["semiconductors", "semiconductor stocks", "chips", "chip stocks", "semis"],
      assetClass: "equity",
      representativeInstruments: [
        listedEtf("SMH", "VanEck Semiconductor ETF", ["vaneck-smh"]),
        listedStock("NVDA", "NVIDIA", ["nasdaq-nvda"]),
        listedStock("AMD", "Advanced Micro Devices", ["nasdaq-amd"]),
        listedStock("AVGO", "Broadcom", ["nasdaq-avgo"]),
      ],
      predictionProxy: listedEtfProxy("SMH", ["vaneck-smh"]),
      sources: [
        source(
          "vaneck-smh",
          "VanEck Semiconductor ETF",
          "https://www.vaneck.com/us/en/investments/semiconductor-etf-smh/",
        ),
        source("nasdaq-nvda", "Nasdaq listed symbol directory: NVDA"),
        source("nasdaq-amd", "Nasdaq listed symbol directory: AMD"),
        source("nasdaq-avgo", "Nasdaq listed symbol directory: AVGO"),
      ],
    },
    {
      subjectKey: "software",
      displayName: "Software",
      aliases: ["software", "software stocks", "application software", "cloud software", "saas"],
      assetClass: "equity",
      representativeInstruments: [
        listedEtf("IGV", "iShares Expanded Tech-Software Sector ETF", ["ishares-igv"]),
        listedStock("MSFT", "Microsoft", ["nasdaq-msft"]),
        listedStock("CRM", "Salesforce", ["nyse-crm"]),
        listedStock("ADBE", "Adobe", ["nasdaq-adbe"]),
      ],
      predictionProxy: listedEtfProxy("IGV", ["ishares-igv"]),
      sources: [
        source(
          "ishares-igv",
          "iShares Expanded Tech-Software Sector ETF",
          "https://www.ishares.com/us/products/239771/ishares-north-american-techsoftware-etf",
        ),
        source("nasdaq-msft", "Nasdaq listed symbol directory: MSFT"),
        source("nyse-crm", "NYSE listed symbol directory: CRM"),
        source("nasdaq-adbe", "Nasdaq listed symbol directory: ADBE"),
      ],
    },
    {
      subjectKey: "cybersecurity",
      displayName: "Cybersecurity",
      aliases: ["cybersecurity", "cyber security", "security software", "cyber stocks"],
      assetClass: "equity",
      representativeInstruments: [
        listedEtf("CIBR", "First Trust Nasdaq Cybersecurity ETF", ["firsttrust-cibr"]),
        listedStock("PANW", "Palo Alto Networks", ["nasdaq-panw"]),
        listedStock("CRWD", "CrowdStrike", ["nasdaq-crwd"]),
        listedStock("FTNT", "Fortinet", ["nasdaq-ftnt"]),
      ],
      predictionProxy: listedEtfProxy("CIBR", ["firsttrust-cibr"]),
      sources: [
        source(
          "firsttrust-cibr",
          "First Trust Nasdaq Cybersecurity ETF",
          "https://www.ftportfolios.com/retail/etf/etfsummary.aspx?Ticker=CIBR",
        ),
        source("nasdaq-panw", "Nasdaq listed symbol directory: PANW"),
        source("nasdaq-crwd", "Nasdaq listed symbol directory: CRWD"),
        source("nasdaq-ftnt", "Nasdaq listed symbol directory: FTNT"),
      ],
    },
    {
      subjectKey: "regional-banks",
      displayName: "Regional Banks",
      aliases: ["regional banks", "regional-bank stocks", "regional banking", "us regional banks"],
      assetClass: "equity",
      representativeInstruments: [
        listedEtf("KRE", "SPDR S&P Regional Banking ETF", ["ssga-kre"]),
        listedStock("FITB", "Fifth Third Bancorp", ["nasdaq-fitb"]),
        listedStock("HBAN", "Huntington Bancshares", ["nasdaq-hban"]),
        listedStock("RF", "Regions Financial", ["nyse-rf"]),
      ],
      predictionProxy: listedEtfProxy("KRE", ["ssga-kre"]),
      sources: [
        source(
          "ssga-kre",
          "SPDR S&P Regional Banking ETF",
          "https://www.ssga.com/us/en/intermediary/etfs/spdr-sp-regional-banking-etf-kre",
        ),
        source("nasdaq-fitb", "Nasdaq listed symbol directory: FITB"),
        source("nasdaq-hban", "Nasdaq listed symbol directory: HBAN"),
        source("nyse-rf", "NYSE listed symbol directory: RF"),
      ],
    },
    {
      subjectKey: "biotech",
      displayName: "Biotechnology",
      aliases: ["biotech", "biotechnology", "biotech stocks", "biotechnology stocks"],
      assetClass: "equity",
      representativeInstruments: [
        listedEtf("XBI", "SPDR S&P Biotech ETF", ["ssga-xbi"]),
        listedStock("AMGN", "Amgen", ["nasdaq-amgn"]),
        listedStock("GILD", "Gilead Sciences", ["nasdaq-gild"]),
        listedStock("VRTX", "Vertex Pharmaceuticals", ["nasdaq-vrtx"]),
      ],
      predictionProxy: listedEtfProxy("XBI", ["ssga-xbi"]),
      sources: [
        source(
          "ssga-xbi",
          "SPDR S&P Biotech ETF",
          "https://www.ssga.com/us/en/intermediary/etfs/spdr-sp-biotech-etf-xbi",
        ),
        source("nasdaq-amgn", "Nasdaq listed symbol directory: AMGN"),
        source("nasdaq-gild", "Nasdaq listed symbol directory: GILD"),
        source("nasdaq-vrtx", "Nasdaq listed symbol directory: VRTX"),
      ],
    },
    {
      subjectKey: "energy",
      displayName: "Energy",
      aliases: ["energy", "energy stocks", "oil and gas", "oil gas", "energy sector"],
      assetClass: "equity",
      representativeInstruments: [
        listedEtf("XLE", "Energy Select Sector SPDR Fund", ["ssga-xle"]),
        listedStock("XOM", "Exxon Mobil", ["nyse-xom"]),
        listedStock("CVX", "Chevron", ["nyse-cvx"]),
        listedStock("COP", "ConocoPhillips", ["nyse-cop"]),
      ],
      predictionProxy: listedEtfProxy("XLE", ["ssga-xle"]),
      sources: [
        source(
          "ssga-xle",
          "Energy Select Sector SPDR Fund",
          "https://www.sectorspdrs.com/mainfund/xle",
        ),
        source("nyse-xom", "NYSE listed symbol directory: XOM"),
        source("nyse-cvx", "NYSE listed symbol directory: CVX"),
        source("nyse-cop", "NYSE listed symbol directory: COP"),
      ],
    },
    {
      subjectKey: "small-caps",
      displayName: "Small Caps",
      aliases: ["small caps", "small-cap stocks", "small cap stocks", "russell 2000"],
      assetClass: "equity",
      representativeInstruments: [
        listedEtf("IWM", "iShares Russell 2000 ETF", ["ishares-iwm"]),
        listedEtf("VTWO", "Vanguard Russell 2000 ETF", ["vanguard-vtwo"]),
      ],
      predictionProxy: listedEtfProxy("IWM", ["ishares-iwm"]),
      sources: [
        source(
          "ishares-iwm",
          "iShares Russell 2000 ETF",
          "https://www.ishares.com/us/products/239710/ishares-russell-2000-etf",
        ),
        source(
          "vanguard-vtwo",
          "Vanguard Russell 2000 ETF",
          "https://investor.vanguard.com/investment-products/etfs/profile/vtwo",
        ),
      ],
    },
    {
      subjectKey: "ai-infrastructure",
      displayName: "AI Infrastructure",
      aliases: [
        "ai infrastructure",
        "ai capex",
        "ai data centers",
        "artificial intelligence infrastructure",
      ],
      assetClass: "equity",
      representativeInstruments: [
        listedStock("NVDA", "NVIDIA", ["nasdaq-nvda"]),
        listedStock("ANET", "Arista Networks", ["nyse-anet"]),
        listedStock("VRT", "Vertiv", ["nyse-vrt"]),
      ],
      sources: [
        source("nasdaq-nvda", "Nasdaq listed symbol directory: NVDA"),
        source("nyse-anet", "NYSE listed symbol directory: ANET"),
        source("nyse-vrt", "NYSE listed symbol directory: VRT"),
      ],
    },
  ]);

export function normalizeResearchSubjectQuery(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/['’]/gu, "")
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

export function resolveResearchSubjectProxy(
  input: string,
  registry: readonly ResearchSubjectRegistryEntry[] = DEFAULT_RESEARCH_SUBJECT_REGISTRY,
): ResearchSubjectProxyResolution {
  const normalizedInput = normalizeResearchSubjectQuery(input);
  const aliasIndex = buildAliasIndex(registry);
  const subject = aliasIndex.get(normalizedInput);

  if (subject === undefined) {
    return {
      input,
      normalizedInput,
      status: "unresolved",
      canEmitPredictions: false,
      reason: "No checked-in subject registry match",
    };
  }

  if (subject.predictionProxy === undefined) {
    return {
      input,
      normalizedInput,
      status: "resolved",
      subject,
      canEmitPredictions: false,
      reason: "Subject has no single listed prediction proxy",
    };
  }

  return {
    input,
    normalizedInput,
    status: "resolved",
    subject,
    predictionProxySymbol: subject.predictionProxy.symbol,
    canEmitPredictions: true,
    reason: "Resolved to checked-in single listed prediction proxy",
  };
}

export function validateResearchSubjectRegistry(
  registry: readonly ResearchSubjectRegistryEntry[],
): ResearchSubjectRegistryValidationResult {
  const errors: string[] = [];
  const aliasOwners = new Map<string, string>();

  for (const entry of registry) {
    const sourceIds = new Set(entry.sources.map((sourceEntry) => sourceEntry.sourceId));
    validateEntryShape(entry, sourceIds, errors);
    validateAliasUniqueness(entry, aliasOwners, errors);
  }

  return { valid: errors.length === 0, errors };
}

function validateDefaultRegistry(
  registry: readonly ResearchSubjectRegistryEntry[],
): readonly ResearchSubjectRegistryEntry[] {
  const validation = validateResearchSubjectRegistry(registry);
  if (!validation.valid) {
    throw new Error(`Invalid research subject registry: ${validation.errors.join("; ")}`);
  }
  return registry;
}

function validateEntryShape(
  entry: ResearchSubjectRegistryEntry,
  sourceIds: ReadonlySet<string>,
  errors: string[],
): void {
  if (!SUBJECT_KEY_RE.test(entry.subjectKey)) {
    errors.push(`${entry.subjectKey}: subjectKey must be a lowercase slug`);
  }
  if (entry.assetClass !== "equity") {
    errors.push(`${entry.subjectKey}: v1 registry supports equity subjects only`);
  }
  if (entry.aliases.length === 0) {
    errors.push(`${entry.subjectKey}: aliases must not be empty`);
  }
  if (entry.representativeInstruments.length === 0) {
    errors.push(`${entry.subjectKey}: representativeInstruments must not be empty`);
  }
  entry.sources.forEach((sourceEntry) => {
    if (sourceEntry.sourceId.trim() === "" || sourceEntry.title.trim() === "") {
      errors.push(`${entry.subjectKey}: source provenance must include sourceId and title`);
    }
  });
  entry.representativeInstruments.forEach((instrument) =>
    validateInstrument(entry.subjectKey, instrument, sourceIds, errors),
  );
  if (entry.predictionProxy !== undefined) {
    validatePredictionProxy(entry.subjectKey, entry.predictionProxy, sourceIds, errors);
  }
}

function validateAliasUniqueness(
  entry: ResearchSubjectRegistryEntry,
  aliasOwners: Map<string, string>,
  errors: string[],
): void {
  const aliases = [entry.subjectKey, entry.displayName, ...entry.aliases].map((alias) =>
    normalizeResearchSubjectQuery(alias),
  );
  for (const alias of aliases) {
    const owner = aliasOwners.get(alias);
    if (owner !== undefined && owner !== entry.subjectKey) {
      errors.push(`${entry.subjectKey}: alias "${alias}" already belongs to ${owner}`);
      continue;
    }
    aliasOwners.set(alias, entry.subjectKey);
  }
}

function validateInstrument(
  subjectKey: string,
  instrument: ResearchSubjectInstrument,
  sourceIds: ReadonlySet<string>,
  errors: string[],
): void {
  if (!SYMBOL_RE.test(instrument.symbol)) {
    errors.push(`${subjectKey}: invalid representative symbol ${instrument.symbol}`);
  }
  validateSourceIds(subjectKey, instrument.sourceIds, sourceIds, errors);
}

function validatePredictionProxy(
  subjectKey: string,
  proxy: ResearchSubjectPredictionProxy,
  sourceIds: ReadonlySet<string>,
  errors: string[],
): void {
  if (!SYMBOL_RE.test(proxy.symbol)) {
    errors.push(`${subjectKey}: invalid prediction proxy symbol ${proxy.symbol}`);
  }
  if (proxy.instrumentType !== "listed-etf") {
    errors.push(`${subjectKey}: prediction proxy must be a listed ETF`);
  }
  validateSourceIds(subjectKey, proxy.sourceIds, sourceIds, errors);
}

function validateSourceIds(
  subjectKey: string,
  itemSourceIds: readonly string[],
  sourceIds: ReadonlySet<string>,
  errors: string[],
): void {
  if (itemSourceIds.length === 0) {
    errors.push(`${subjectKey}: registry items must cite sourceIds`);
  }
  itemSourceIds.forEach((sourceId) => {
    if (!sourceIds.has(sourceId)) {
      errors.push(`${subjectKey}: unknown sourceId ${sourceId}`);
    }
  });
}

function buildAliasIndex(
  registry: readonly ResearchSubjectRegistryEntry[],
): ReadonlyMap<string, ResearchSubjectRegistryEntry> {
  const aliases = registry.flatMap((entry) =>
    [entry.subjectKey, entry.displayName, ...entry.aliases].map(
      (alias) => [normalizeResearchSubjectQuery(alias), entry] as const,
    ),
  );
  return new Map(aliases);
}

function listedEtf(
  symbol: string,
  name: string,
  sourceIds: readonly string[],
): ResearchSubjectInstrument {
  return { symbol, name, instrumentType: "listed-etf", sourceIds };
}

function listedStock(
  symbol: string,
  name: string,
  sourceIds: readonly string[],
): ResearchSubjectInstrument {
  return { symbol, name, instrumentType: "listed-stock", sourceIds };
}

function listedEtfProxy(
  symbol: string,
  sourceIds: readonly string[],
): ResearchSubjectPredictionProxy {
  return { symbol, instrumentType: "listed-etf", sourceIds };
}

function source(sourceId: string, title: string, url?: string): ResearchSubjectSource {
  return { sourceId, title, ...(url !== undefined ? { url } : {}) };
}
