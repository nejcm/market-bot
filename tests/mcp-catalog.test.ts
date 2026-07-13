import { describe, expect, test } from "bun:test";
import { loadMcpCatalog, parseMcpCatalog, resolveHeaderTemplate } from "../src/sources/mcp/catalog";

describe("parseMcpCatalog", () => {
  test("parses a valid http entry", () => {
    const catalog = parseMcpCatalog(
      JSON.stringify({ mcpServers: { mtnewswire: { type: "http", url: "https://mt.test/mcp" } } }),
    );
    expect(catalog.gaps).toEqual([]);
    expect(catalog.servers).toEqual([
      { id: "mtnewswire", type: "http", url: "https://mt.test/mcp" },
    ]);
  });

  test("recognizes a stdio entry without initializing it", () => {
    const catalog = parseMcpCatalog(
      JSON.stringify({
        mcpServers: { local: { type: "stdio", command: "server", args: ["--x"] } },
      }),
    );
    expect(catalog.gaps).toEqual([]);
    expect(catalog.servers).toEqual([
      { id: "local", type: "stdio", command: "server", args: ["--x"] },
    ]);
  });

  test("accepts an env-template header and rejects a literal credential", () => {
    const ok = parseMcpCatalog(
      JSON.stringify({
        mcpServers: {
          a: { type: "http", url: "https://a.test", headers: { Authorization: "Bearer ${TOKEN}" } },
        },
      }),
    );
    expect(ok.gaps).toEqual([]);
    expect(ok.servers[0]).toMatchObject({ headers: { Authorization: "Bearer ${TOKEN}" } });

    const literal = parseMcpCatalog(
      JSON.stringify({
        mcpServers: {
          a: { type: "http", url: "https://a.test", headers: { Authorization: "Bearer sk-123" } },
        },
      }),
    );
    expect(literal.servers).toEqual([]);
    expect(literal.gaps).toHaveLength(1);
    expect(literal.gaps[0]?.capability).toBe("mcp");
  });

  test("rejects non-https and credential-bearing urls", () => {
    const http = parseMcpCatalog(
      JSON.stringify({ mcpServers: { a: { type: "http", url: "http://a.test" } } }),
    );
    expect(http.servers).toEqual([]);
    expect(http.gaps).toHaveLength(1);

    const userinfo = parseMcpCatalog(
      JSON.stringify({ mcpServers: { a: { type: "http", url: "https://u:p@a.test" } } }),
    );
    expect(userinfo.servers).toEqual([]);
    expect(userinfo.gaps).toHaveLength(1);
  });

  test("isolates a bad entry while keeping a good one", () => {
    const catalog = parseMcpCatalog(
      JSON.stringify({
        mcpServers: {
          good: { type: "http", url: "https://good.test" },
          bad: { type: "http", url: "http://bad.test" },
        },
      }),
    );
    expect(catalog.servers.map((s) => s.id)).toEqual(["good"]);
    expect(catalog.gaps).toHaveLength(1);
  });

  test("turns malformed JSON into a non-fatal gap", () => {
    const catalog = parseMcpCatalog("{ not json");
    expect(catalog.servers).toEqual([]);
    expect(catalog.gaps).toHaveLength(1);
    expect(catalog.gaps[0]?.capability).toBe("mcp");
    expect(catalog.gaps[0]?.evidenceQualityImpact).toBe("no-cap");
  });

  test("treats a missing mcpServers object as an empty catalog", () => {
    const catalog = parseMcpCatalog(JSON.stringify({}));
    expect(catalog.servers).toEqual([]);
    expect(catalog.gaps).toEqual([]);
  });
});

describe("resolveHeaderTemplate", () => {
  test("resolves a present variable", () => {
    expect(resolveHeaderTemplate("Bearer ${TOKEN}", { TOKEN: "abc" })).toBe("Bearer abc");
  });

  test("returns undefined when any variable is unset", () => {
    expect(resolveHeaderTemplate("Bearer ${TOKEN}", {})).toBeUndefined();
    expect(resolveHeaderTemplate("Bearer ${TOKEN}", { TOKEN: "" })).toBeUndefined();
  });
});

describe("loadMcpCatalog (repo root)", () => {
  test("loads the checked-in mtnewswire catalog", async () => {
    const catalog = await loadMcpCatalog();
    expect(catalog.gaps).toEqual([]);
    expect(catalog.servers.map((s) => s.id)).toContain("mtnewswire");
  });
});
