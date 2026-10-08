import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server/index.js";
import { setup } from "./helpers.js";

async function connect(t: ReturnType<typeof setup>, scope = "alpha") {
  const session = t.atlas.session({ cwd: t.cwd(scope) });
  const server = createServer(session);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: Boolean(r.isError) };
  };
  return { client, call, session };
}

describe("MCP server", () => {
  it("offers the eleven tools", async () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const { client } = await connect(t);
    const names = (await client.listTools()).tools.map((x) => x.name).sort();
    expect(names).toEqual(["amend", "brief", "close_session", "log", "pending", "scopes", "seal", "search", "summarize", "topic", "zoom"]);
  });

  it("puts the compact brief and usage in the server instructions", async () => {
    const t = setup("2026-10-07T10:00:00+02:00");
    const first = t.atlas.session({ cwd: t.cwd("alpha") });
    first.closeSession({ headline: "Wednesday parser work", summary: "### Open threads\n- unicode" });
    t.at("2026-10-08T10:00:00+02:00");
    const { client } = await connect(t);
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain('The current scope is "alpha"');
    expect(instructions).toContain("Wednesday parser work");
    expect(instructions).toContain("1 rollup pending");
  });

  it("records, closes and briefs through tool calls", async () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const { call } = await connect(t);
    expect((await call("log", { type: "decision", text: "Use MiniSearch", topics: ["Search"] })).isError).toBe(false);
    const closed = await call("close_session", { headline: "Search chosen", summary: "### Decisions\n- MiniSearch" });
    expect(closed.text).toContain("closed");
    expect((await call("brief")).text).toContain("Search chosen");
    expect((await call("search", { query: "minisearch" })).text).toContain("alpha");
  });

  it("runs a full rollup through summarize and seal", async () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    t.atlas.session({ cwd: t.cwd("alpha") }).closeSession({ headline: "Thursday", summary: "work" });
    t.at("2026-10-09T09:00:00+02:00");
    const { call } = await connect(t);
    expect((await call("pending")).text).toContain("2026-10-08");
    const job = await call("summarize", { period: "2026-10-08" });
    expect(job.text).toContain("about 600 tokens");
    const sealed = await call("seal", { period: "2026-10-08", headline: "Thursday sealed", content: "### What happened\n- work" });
    expect(sealed.isError).toBe(false);
    expect((await call("zoom", { period: "2026-10-08" })).text).toContain("sealed");
  });

  it("returns errors as tool errors", async () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const { call } = await connect(t);
    const r = await call("zoom", { period: "not a period" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("neither a period id nor a session");
  });

  it("attaches the day-change notice to the first call after the boundary", async () => {
    const t = setup("2026-10-07T22:00:00+02:00");
    const { call } = await connect(t);
    await call("log", { type: "change", text: "evening" });
    t.at("2026-10-08T09:00:00+02:00");
    const r = await call("log", { type: "change", text: "morning" });
    expect(r.text).toContain("[Temporal Atlas checkpoint]");
    expect(r.text).toContain('segment: "2026-10-07"');
  });
});
