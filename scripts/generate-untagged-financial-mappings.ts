import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  FinancialTableCellMapping,
  FinancialTableSemanticField,
} from "../src/sources/extended-evidence/untagged-financial-tables-contract";

interface MappingSpec {
  readonly field: FinancialTableSemanticField;
  readonly labelCellRef: string;
  readonly valueCellRef: string;
  readonly headers: readonly string[];
  readonly expectedDisplayedValue: number;
  readonly signCellRef?: string;
}

const CORPUS_DIR = join(import.meta.dir, "..", "tests", "fixtures", "untagged-financial-corpus");

function spec(
  field: FinancialTableSemanticField,
  labelCellRef: string,
  valueCellRef: string,
  headers: readonly string[],
  expectedDisplayedValue: number,
  signCellRef?: string,
): MappingSpec {
  return {
    field,
    labelCellRef,
    valueCellRef,
    headers,
    expectedDisplayedValue,
    ...(signCellRef !== undefined ? { signCellRef } : {}),
  };
}

const NBIS_BALANCE = ["t002:r002:c005", "t002:r003:c007", "t002:r004:c007"];
const NBIS_INCOME = ["t003:r002:c005", "t003:r003:c007"];
const NBIS_CASH = ["t005:r002:c005", "t005:r003:c007"];
const SE_INCOME = ["t003:r002:c003", "t003:r003:c007"];
const seBalance = (table: string): readonly string[] => [
  `${table}:r002:c007`,
  `${table}:r003:c007`,
];
const SE_CASH = ["t007:r002:c003", "t007:r003:c007"];
const SPOT_INCOME = ["t002:r002:c010", "t002:r003:c010"];
const SPOT_BALANCE = ["t004:r002:c010"];
const SPOT_CASH = ["t005:r002:c010", "t005:r003:c010"];
const ARM_INCOME = ["t002:r002:c004", "t002:r003:c004"];
const ARM_BALANCE = ["t003:r002:c004", "t003:r003:c004"];
const ARM_CASH = ["t004:r002:c004", "t004:r003:c004"];
const NVO_INCOME = ["t003:r004:c004"];
const NVO_CASH = ["t005:r003:c004"];
const NVO_BALANCE = ["t007:r003:c004"];
const GRAB_INCOME = ["t003:r002:c004", "t003:r003:c004"];
const GRAB_BALANCE = ["t004:r002:c004"];
const GRAB_CASH = ["t006:r002:c004", "t006:r003:c004"];
const BABA_INCOME = ["t004:r001:c003", "t004:r002:c007"];
const BABA_BALANCE = ["t008:r001:c007", "t008:r002:c007"];
const BABA_BALANCE_CONTINUED = ["t009:r001:c007", "t009:r002:c007"];
const PDD_BALANCE = ["t001:r001:c003", "t001:r002:c007", "t001:r003:c007"];
const PDD_BALANCE_CONTINUED = ["t002:r001:c003", "t002:r002:c007", "t002:r003:c007"];
const PDD_INCOME = ["t003:r001:c003", "t003:r002:c007", "t003:r003:c007", "t003:r004:c007"];
const PDD_CASH = ["t005:r001:c003", "t005:r002:c007", "t005:r003:c007", "t005:r004:c007"];

const CASES: Readonly<Record<string, readonly MappingSpec[]>> = {
  "nbis-2026-q1": [
    spec("cash", "t002:r006:c001", "t002:r006:c007", NBIS_BALANCE, 9298.2),
    spec("totalAssets", "t002:r021:c001", "t002:r021:c007", NBIS_BALANCE, 22_303.3),
    spec("totalLiabilities", "t002:r033:c001", "t002:r033:c007", NBIS_BALANCE, 15_061.4),
    spec("stockholdersEquity", "t002:r043:c001", "t002:r043:c007", NBIS_BALANCE, 7241.9),
    spec("revenue", "t003:r004:c001", "t003:r004:c007", NBIS_INCOME, 399),
    spec("operatingIncome", "t003:r011:c001", "t003:r011:c007", NBIS_INCOME, -128),
    spec("netIncome", "t003:r021:c001", "t003:r021:c007", NBIS_INCOME, 621.2),
    spec("operatingCashFlow", "t005:r027:c001", "t005:r027:c007", NBIS_CASH, 2258),
    spec("investingCashFlow", "t005:r033:c001", "t005:r033:c007", NBIS_CASH, -2643.1),
    spec("financingCashFlow", "t005:r042:c001", "t005:r042:c007", NBIS_CASH, 6295.5),
    spec("foreignExchangeEffect", "t005:r043:c001", "t005:r043:c007", NBIS_CASH, -5.1),
    spec("netCashChange", "t005:r044:c001", "t005:r044:c007", NBIS_CASH, 5905.3),
    spec("cashBeginning", "t005:r045:c001", "t005:r045:c007", NBIS_CASH, 3721.6),
    spec("cashEnding", "t005:r046:c001", "t005:r046:c007", NBIS_CASH, 9626.9),
  ],
  "se-2026-q1": [
    spec("revenue", "t003:r009:c001", "t003:r009:c008", SE_INCOME, 7_097_489),
    spec("operatingIncome", "t003:r028:c001", "t003:r028:c008", SE_INCOME, 592_987),
    spec("netIncome", "t003:r039:c001", "t003:r039:c008", SE_INCOME, 438_222),
    spec("cash", "t004:r007:c001", "t004:r007:c008", seBalance("t004"), 4_035_175),
    spec("totalAssets", "t004:r032:c001", "t004:r032:c008", seBalance("t004"), 30_590_229),
    spec("totalLiabilities", "t005:r031:c001", "t005:r031:c008", seBalance("t005"), 17_608_848),
    spec("stockholdersEquity", "t006:r017:c001", "t006:r017:c008", seBalance("t006"), 12_981_381),
    spec("operatingCashFlow", "t007:r005:c001", "t007:r005:c008", SE_CASH, 1_057_905),
    spec(
      "investingCashFlow",
      "t007:r006:c001",
      "t007:r006:c008",
      SE_CASH,
      -1_603_988,
      "t007:r006:c009",
    ),
    spec("financingCashFlow", "t007:r007:c001", "t007:r007:c008", SE_CASH, 479_945),
    spec(
      "foreignExchangeEffect",
      "t007:r008:c001",
      "t007:r008:c008",
      SE_CASH,
      -54_237,
      "t007:r008:c009",
    ),
    spec("netCashChange", "t007:r009:c001", "t007:r009:c008", SE_CASH, -120_375, "t007:r009:c009"),
    spec("cashBeginning", "t007:r010:c001", "t007:r010:c008", SE_CASH, 6_419_467),
    spec("cashEnding", "t007:r012:c001", "t007:r012:c008", SE_CASH, 6_299_092),
  ],
  "pdd-2026-q1": [
    spec("cash", "t001:r007:c001", "t001:r007:c008", PDD_BALANCE, 123_041),
    spec("totalAssets", "t001:r022:c001", "t001:r022:c008", PDD_BALANCE, 637_704),
    spec("totalLiabilities", "t002:r019:c001", "t002:r019:c008", PDD_BALANCE_CONTINUED, 214_277),
    spec("stockholdersEquity", "t002:r027:c001", "t002:r027:c008", PDD_BALANCE_CONTINUED, 423_427),
    spec("revenue", "t003:r005:c001", "t003:r005:c008", PDD_INCOME, 106_229),
    spec("operatingIncome", "t003:r013:c001", "t003:r013:c008", PDD_INCOME, 19_566),
    spec("netIncome", "t003:r022:c001", "t003:r022:c008", PDD_INCOME, 12_547),
    spec("operatingCashFlow", "t005:r005:c001", "t005:r005:c008", PDD_CASH, 16_445),
    spec("investingCashFlow", "t005:r006:c001", "t005:r006:c008", PDD_CASH, 2082),
    spec(
      "foreignExchangeEffect",
      "t005:r008:c001",
      "t005:r008:c008",
      PDD_CASH,
      -2005,
      "t005:r008:c009",
    ),
    spec("netCashChange", "t005:r010:c001", "t005:r010:c008", PDD_CASH, 16_522),
    spec("cashBeginning", "t005:r011:c001", "t005:r011:c008", PDD_CASH, 182_732),
    spec("cashEnding", "t005:r012:c001", "t005:r012:c008", PDD_CASH, 199_254),
  ],
  "spot-2026-q1": [
    spec("revenue", "t002:r004:c001", "t002:r004:c010", SPOT_INCOME, 4533),
    spec("operatingIncome", "t002:r011:c001", "t002:r011:c010", SPOT_INCOME, 715),
    spec("netIncome", "t002:r017:c001", "t002:r017:c010", SPOT_INCOME, 721),
    spec("cash", "t004:r019:c001", "t004:r019:c010", SPOT_BALANCE, 5255),
    spec("totalAssets", "t004:r022:c001", "t004:r022:c010", SPOT_BALANCE, 13_128),
    spec("totalLiabilities", "t004:r047:c001", "t004:r047:c010", SPOT_BALANCE, 5118),
    spec("stockholdersEquity", "t004:r030:c001", "t004:r030:c010", SPOT_BALANCE, 8010),
    spec("operatingCashFlow", "t005:r023:c001", "t005:r023:c010", SPOT_CASH, 836),
    spec("investingCashFlow", "t005:r032:c001", "t005:r032:c010", SPOT_CASH, 732),
    spec("financingCashFlow", "t005:r042:c001", "t005:r042:c010", SPOT_CASH, -1611),
    spec("netCashChange", "t005:r043:c001", "t005:r043:c010", SPOT_CASH, -43),
    spec("cashBeginning", "t005:r044:c001", "t005:r044:c010", SPOT_CASH, 5258),
    spec("foreignExchangeEffect", "t005:r045:c001", "t005:r045:c010", SPOT_CASH, 40),
    spec("cashEnding", "t005:r046:c001", "t005:r046:c010", SPOT_CASH, 5255),
  ],
  "arm-2026-fy": [
    spec("revenue", "t002:r007:c001", "t002:r007:c004", ARM_INCOME, 1490),
    spec("operatingIncome", "t002:r016:c001", "t002:r016:c004", ARM_INCOME, 438),
    spec("netIncome", "t002:r027:c001", "t002:r027:c005", ARM_INCOME, 313),
    spec("cash", "t003:r006:c001", "t003:r006:c005", ARM_BALANCE, 2751),
    spec("totalAssets", "t003:r025:c001", "t003:r025:c005", ARM_BALANCE, 10_703),
    spec("totalLiabilities", "t003:r043:c001", "t003:r043:c004", ARM_BALANCE, 2417),
    spec("stockholdersEquity", "t003:r049:c001", "t003:r049:c004", ARM_BALANCE, 8286),
    spec("operatingCashFlow", "t004:r024:c001", "t004:r024:c005", ARM_CASH, 260),
    spec("investingCashFlow", "t004:r036:c001", "t004:r036:c005", ARM_CASH, -201),
    spec("financingCashFlow", "t004:r046:c001", "t004:r046:c005", ARM_CASH, -105),
    spec("foreignExchangeEffect", "t004:r048:c001", "t004:r048:c004", ARM_CASH, -10),
    spec("netCashChange", "t004:r049:c001", "t004:r049:c004", ARM_CASH, -56),
    spec("cashBeginning", "t004:r050:c001", "t004:r050:c004", ARM_CASH, 2807),
    spec("cashEnding", "t004:r051:c001", "t004:r051:c005", ARM_CASH, 2751),
  ],
  "nvo-2026-q1": [
    spec("revenue", "t003:r009:c001", "t003:r009:c004", NVO_INCOME, 96_823),
    spec("operatingIncome", "t003:r021:c001", "t003:r021:c004", NVO_INCOME, 59_618),
    spec("netIncome", "t003:r032:c001", "t003:r032:c004", NVO_INCOME, 48_557),
    spec("cash", "t007:r025:c001", "t007:r025:c004", NVO_BALANCE, 21_127),
    spec("totalAssets", "t007:r028:c001", "t007:r028:c004", NVO_BALANCE, 559_221),
    spec("totalLiabilities", "t007:r061:c001", "t007:r061:c004", NVO_BALANCE, 356_156),
    spec("stockholdersEquity", "t007:r038:c001", "t007:r038:c004", NVO_BALANCE, 203_065),
    spec("operatingCashFlow", "t005:r018:c001", "t005:r018:c004", NVO_CASH, 24_084),
    spec("investingCashFlow", "t005:r034:c001", "t005:r034:c004", NVO_CASH, -11_712),
    spec("financingCashFlow", "t005:r046:c001", "t005:r046:c004", NVO_CASH, -17_433),
    spec("netCashChange", "t005:r049:c001", "t005:r049:c004", NVO_CASH, -5061),
    spec("cashBeginning", "t005:r051:c001", "t005:r051:c004", NVO_CASH, 26_464),
    spec("foreignExchangeEffect", "t005:r052:c001", "t005:r052:c004", NVO_CASH, -276),
    spec("cashEnding", "t005:r055:c001", "t005:r055:c004", NVO_CASH, 21_127),
  ],
  "grab-2026-q1": [
    spec("revenue", "t003:r005:c001", "t003:r005:c004", GRAB_INCOME, 955),
    spec("operatingIncome", "t003:r014:c001", "t003:r014:c004", GRAB_INCOME, 22),
    spec("netIncome", "t003:r022:c001", "t003:r022:c004", GRAB_INCOME, 120),
    spec("cash", "t004:r019:c001", "t004:r019:c004", GRAB_BALANCE, 2948),
    spec("totalAssets", "t004:r021:c001", "t004:r021:c004", GRAB_BALANCE, 11_700),
    spec("totalLiabilities", "t005:r010:c001", "t005:r010:c004", GRAB_BALANCE, 5166),
    spec("stockholdersEquity", "t004:r028:c001", "t004:r028:c004", GRAB_BALANCE, 6534),
    spec("operatingCashFlow", "t006:r028:c001", "t006:r028:c004", GRAB_CASH, -59),
    spec("investingCashFlow", "t007:r005:c001", "t007:r005:c004", GRAB_CASH, 15),
    spec("financingCashFlow", "t007:r017:c001", "t007:r017:c004", GRAB_CASH, -418),
    spec("netCashChange", "t007:r019:c001", "t007:r019:c004", GRAB_CASH, -462),
    spec("cashBeginning", "t007:r020:c001", "t007:r020:c004", GRAB_CASH, 3433),
    spec("foreignExchangeEffect", "t007:r021:c001", "t007:r021:c004", GRAB_CASH, -23),
    spec("cashEnding", "t007:r022:c001", "t007:r022:c004", GRAB_CASH, 2948),
  ],
  "baba-2026-fy": [
    spec("revenue", "t004:r005:c001", "t004:r005:c008", BABA_INCOME, 1_023_670),
    spec("operatingIncome", "t004:r007:c001", "t004:r007:c008", BABA_INCOME, 50_150),
    spec("netIncome", "t004:r014:c001", "t004:r014:c008", BABA_INCOME, 102_127),
    spec("cash", "t008:r007:c001", "t008:r007:c008", BABA_BALANCE, 131_530),
    spec("totalAssets", "t008:r020:c001", "t008:r020:c008", BABA_BALANCE, 1_909_570),
    spec("totalLiabilities", "t009:r012:c001", "t009:r012:c008", BABA_BALANCE_CONTINUED, 783_300),
    spec(
      "stockholdersEquity",
      "t009:r029:c001",
      "t009:r029:c008",
      BABA_BALANCE_CONTINUED,
      1_118_425,
    ),
  ],
};

await Promise.all(
  Object.entries(CASES).flatMap(([id, specs]) => {
    const mappings: FinancialTableCellMapping[] = specs.map((item) => ({
      field: item.field,
      labelCellRef: item.labelCellRef,
      valueCellRef: item.valueCellRef,
      ...(item.signCellRef !== undefined ? { signCellRef: item.signCellRef } : {}),
      periodHeaderCellRefs: item.headers,
    }));
    return [
      mkdir(join(CORPUS_DIR, "mappings"), { recursive: true }).then(() =>
        writeFile(
          join(CORPUS_DIR, "mappings", `${id}.json`),
          `${JSON.stringify({ version: 1, mappings }, null, 2)}\n`,
          "utf8",
        ),
      ),
      mkdir(join(CORPUS_DIR, "oracles"), { recursive: true }).then(() =>
        writeFile(
          join(CORPUS_DIR, "oracles", `${id}.json`),
          `${JSON.stringify(
            {
              values: specs.map((item) => ({
                field: item.field,
                displayedValue: item.expectedDisplayedValue,
                valueCellRef: item.valueCellRef,
                ...(item.signCellRef !== undefined ? { signCellRef: item.signCellRef } : {}),
              })),
            },
            null,
            2,
          )}\n`,
          "utf8",
        ),
      ),
    ];
  }),
);
