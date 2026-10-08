import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Atlas, type AtlasSession } from "../atlas.js";
import type { PendingItem } from "../rollup/index.js";
import { EVENT_TYPES } from "../sessions/note.js";
import { VERSION } from "../version.js";

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(body: string, notice?: string): Text {
  return { content: [{ type: "text", text: notice ? `${body}\n\n${notice}` : body }] };
}

function pendingText(p: { items: PendingItem[]; totalTokens: number; gateTokens: number }): string {
  if (!p.items.length) return "No rollups pending.";
  const lines = p.items.map((i) => {
    const flags = [i.gate, i.blocked ? `waiting on ${i.waitingOn.join(", ")}` : "", i.stale ? "stale" : ""].filter(Boolean).join(", ");
    return `- ${i.period} (${i.layer}, scope ${i.scope}, about ${i.tokens} tokens; ${flags})`;
  });
  const over = p.totalTokens > p.gateTokens;
  return [
    `${p.items.length} rollup(s) pending, about ${p.totalTokens} tokens in total. Cost gate: ${p.gateTokens} tokens${over ? "; items marked needs_confirmation need the user's go-ahead" : ""}.`,
    "Work in order: summarize, write, seal. Items waiting on others become available as you seal.",
    ...lines,
  ].join("\n");
}

/** Build the MCP server for one agent session. */
export function createServer(session: AtlasSession): McpServer {
  const server = new McpServer({ name: "temporal-atlas", version: VERSION }, { instructions: session.instructions() });

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (args: z.infer<z.ZodObject<S>>) => string,
    readOnly = false,
  ) => {
    server.registerTool(
      name,
      { description, inputSchema: shape, annotations: { readOnlyHint: readOnly } },
      (async (args: z.infer<z.ZodObject<S>>) => {
        const notice = session.checkpoint();
        try {
          return text(run(args), notice);
        } catch (err) {
          return { ...text(err instanceof Error ? err.message : String(err), notice), isError: true };
        }
      }) as never,
    );
  };

  const scope = z.string().optional().describe("Scope to act on. Defaults to this session's scope.");

  tool(
    "brief",
    "The layered view of recent work in a scope: last session, today, last worked day, this and last week, month and year, other scopes this week, and pending rollups. Call at the start of work if the brief in the server instructions is not enough.",
    { scope, lookback: z.number().int().min(1).max(12).optional().describe("How many closed periods to show per layer. Default 1.") },
    (a) => session.brief(a),
    true,
  );

  tool(
    "log",
    "Record an event in this session as it happens: a decision (with the reason), a notable change, a finding, a todo or a note. One sentence each. Creates the session note on first use.",
    {
      type: z.enum(EVENT_TYPES),
      text: z.string().min(1),
      topics: z.array(z.string()).optional().describe("Topic names this event relates to."),
      scope: z.string().optional().describe("Only on the first call, when the scope could not be detected (no working directory)."),
    },
    (a) => {
      const r = session.log(a);
      return `Logged to session ${r.session} (scope ${r.scope}, ${r.day}).`;
    },
  );

  tool(
    "close_session",
    "Write this session's summary. Call before you finish. headline: one line. summary: Markdown with ### Done, ### Decisions (with reasons), ### Files, ### Open threads. With segment set to an earlier day, summarizes that day's part and keeps the session open (used after a day-change notice).",
    {
      headline: z.string().min(1),
      summary: z.string().min(1),
      segment: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    },
    (a) => {
      const r = session.closeSession(a);
      const state = r.closed ? "Session closed." : `Summary for ${r.segment} saved; the session stays open.`;
      return r.pending.items.length ? `${state}\n\n${pendingText(r.pending)}` : state;
    },
  );

  tool(
    "pending",
    "List closed periods that need a summary (rollups), oldest first, with token estimates and the cost gate. Use when the user asks to tidy the atlas, or after a checkpoint notice.",
    { all: z.boolean().optional().describe("Include every scope this session can see, not only its own.") },
    (a) => pendingText(session.pending(a)),
    true,
  );

  tool(
    "summarize",
    "Start one rollup: returns the source notes, the length target and how to write the summary. Then call seal. Items past the cost gate need confirmed: true, which you may only pass after the user agrees.",
    {
      period: z.string().describe("A period id (2026-10-08, 2026-W41, 2026-10, 2026) or an orphan session id."),
      scope,
      confirmed: z.boolean().optional(),
    },
    (a) => {
      const job = session.summarize(a);
      return `${job.instructions}\n\n# Sources for ${job.period} (${job.layer}, scope ${job.scope})\n\n${job.sources}`;
    },
  );

  tool(
    "seal",
    "Save the summary of a closed period and seal it. headline: one line. content: Markdown within the length target. topic_updates: optional changes to durable knowledge found in this period.",
    {
      period: z.string(),
      scope,
      headline: z.string().min(1),
      content: z.string().min(1),
      topic_updates: z
        .array(z.object({ name: z.string(), state: z.string().optional(), entry: z.string().optional() }))
        .optional()
        .describe("state replaces the topic's current state; entry is added to its timeline."),
    },
    (a) => {
      const r = session.seal({ ...a, topicUpdates: a.topic_updates });
      const parts = [`Sealed ${r.period} (scope ${r.scope}).`];
      if (r.unblocked.length) parts.push(`Now available: ${r.unblocked.join(", ")}.`);
      if (r.nowStale.length) parts.push(`Marked stale: ${r.nowStale.join(", ")}.`);
      if (r.topics.length) parts.push(`Topics updated: ${r.topics.join(", ")}.`);
      parts.push(`${r.remaining} rollup(s) still pending.`);
      return parts.join(" ");
    },
  );

  tool(
    "zoom",
    "Open one period note (sealed, or a live draft) or one session, with the list of notes beneath it, to move from a year down to the sessions behind a day.",
    { period: z.string().describe("A period id or a session id."), scope },
    (a) => {
      const z = session.zoom(a);
      const beneath = z.children.length ? `\n\n## Beneath\n${z.children.map((c) => `- ${c.id} (${c.layer}, ${c.status}): ${c.headline}`).join("\n")}` : "";
      return `# ${z.id} (${z.layer}, ${z.status}, scope ${z.scope})\n\n${z.content}${beneath}\n\nAbove: ${z.parents.join(", ") || "none"}`;
    },
    true,
  );

  tool(
    "search",
    "Keyword search across every note this session can see. Filter by scope, layer (session, day, week, month, year, topic) and date range (YYYY-MM-DD).",
    {
      query: z.string().min(1),
      scope,
      layer: z.enum(["session", "day", "week", "month", "year", "topic"]).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    (a) => {
      const results = session.search(a);
      if (!results.length) return "No matches.";
      return results.map((r) => `- ${r.note} (${r.layer} ${r.period}, scope ${r.scope}, score ${r.score})\n  ${r.snippet}`).join("\n");
    },
    true,
  );

  tool(
    "topic",
    "Read a topic note (durable knowledge about one subject), or create or update it. Without update it reads. update.state replaces 'What we know now'; update.entry adds a dated timeline line. Similar existing names are offered instead of creating a duplicate unless force is true.",
    {
      name: z.string().min(1),
      scope,
      update: z.object({ state: z.string().optional(), entry: z.string().optional() }).optional(),
      force: z.boolean().optional(),
    },
    (a) => {
      const r = session.topic(a);
      if (r.similar?.length && !r.exists) {
        return `No topic named "${r.name}". Similar: ${r.similar.join(", ")}. Use one of those, or pass force: true to create "${r.name}".`;
      }
      if (!r.exists) return `No topic named "${r.name}" in scope ${r.scope}.`;
      return `${r.created ? "Created" : a.update ? "Updated" : "Topic"} ${r.name} (scope ${r.scope})\n\n${r.content}`;
    },
  );

  tool(
    "scopes",
    "List scopes this session can see, or change one: isolated (hide it from every other scope), mapHere (send this folder's future sessions to that scope), mergeInto (move all its notes into another scope).",
    {
      set: z
        .object({ scope: z.string(), isolated: z.boolean().optional(), mapHere: z.boolean().optional(), mergeInto: z.string().optional() })
        .optional(),
    },
    (a) => {
      const r = session.scopes(a);
      const list = r.scopes.map((s) => `- ${s.name}${s.isolated ? " (isolated)" : ""}${s.name === r.current ? " (current)" : ""}`).join("\n");
      const rules = r.rules.length ? `\n\nRules:\n${r.rules.map((x) => `- ${x.kind} ${x.match} -> ${x.scope}`).join("\n")}` : "";
      return `${list}${rules}`;
    },
  );

  tool(
    "amend",
    "Correct a sealed period note or a session note. Adds a dated entry with the reason under Amendments, and marks the notes built on it stale so they get re-summarized.",
    { note: z.string().describe("A period id or a session id."), change: z.string().min(1), reason: z.string().min(1), scope },
    (a) => {
      const r = session.amend(a);
      return `Amended ${r.note}.${r.nowStale.length ? ` Marked stale: ${r.nowStale.join(", ")}.` : ""}`;
    },
  );

  server.server.onclose = () => session.disconnect();
  return server;
}

export function atlasDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TEMPORAL_ATLAS_DIR || `${env.HOME ?? ""}/TemporalAtlas`;
}

/** Start the server over stdio for the agent that launched this process. */
export async function runStdio() {
  const atlas = new Atlas({ dir: atlasDir() });
  const session = atlas.session({
    cwd: process.env.TEMPORAL_ATLAS_CWD || process.cwd(),
    clientSessionId: process.env.CLAUDE_CODE_SESSION_ID || undefined,
    client: process.env.CLAUDECODE ? "claude-code" : undefined,
  });
  const server = createServer(session);
  await server.connect(new StdioServerTransport());
  const close = () => {
    session.disconnect();
    process.exit(0);
  };
  process.stdin.on("end", close);
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}
