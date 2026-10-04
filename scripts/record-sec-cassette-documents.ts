// Adds named public sec.gov documents to one fixture's data cassette. No other provider is called.
// Usage: bun run scripts/record-sec-cassette-documents.ts <fixture> <sec.gov URL>...
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  dataCassetteKey,
  type DataCassetteEntry,
} from "../tests/support/run-fixtures/data-cassette";

const USER_AGENT =
  process.env.MARKET_BOT_SEC_USER_AGENT ?? "market-bot fixture recorder contact@example.invalid";
const [fixtureName, ...urls] = process.argv.slice(2);
if (fixtureName === undefined || urls.length === 0) {
  throw new Error("Usage: record-sec-cassette-documents.ts <fixture> <sec.gov URL>...");
}
for (const url of urls) {
  if (new URL(url).hostname !== "www.sec.gov") {
    throw new Error(`Refusing non-SEC URL: ${url}`);
  }
}

const cassettePath = join(
  import.meta.dir,
  "..",
  "tests",
  "fixtures",
  "runs",
  fixtureName,
  "data-cassette.json",
);
const cassette = JSON.parse(await readFile(cassettePath, "utf8")) as {
  entries: Record<string, DataCassetteEntry>;
};
for (const url of urls) {
  // Serialized to respect SEC fair-access limits.
  // eslint-disable-next-line no-await-in-loop
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, redirect: "error" });
  if (!response.ok) {
    throw new Error(`SEC request failed (${String(response.status)}): ${url}`);
  }
  // eslint-disable-next-line no-await-in-loop
  const body = await response.text();
  cassette.entries[
    // eslint-disable-next-line no-await-in-loop
    await dataCassetteKey(url)
  ] = {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "text/html" },
    body,
  };
}
await writeFile(cassettePath, `${JSON.stringify(cassette, null, 2)}\n`, "utf8");
