import { existsSync, readFileSync } from "node:fs";
/** The user or assistant text of one Codex rollout entry: its finished messages. */
function codexLine(payload) {
    const item = payload.type === "item_completed" ? payload.item : undefined;
    if (item?.type !== "UserMessage" && item?.type !== "AgentMessage")
        return undefined;
    const text = (item.content ?? [])
        .filter((b) => b.text)
        .map((b) => b.text)
        .join("\n")
        .trim();
    return text ? `${item.type === "UserMessage" ? "User" : "Assistant"}: ${text}` : undefined;
}
/**
 * Pull the human-readable conversation out of a Claude Code or Codex JSONL transcript,
 * dropping tool calls and tool output. Returns "" when the file is missing.
 */
export function transcriptText(path, maxChars) {
    if (!existsSync(path))
        return "";
    const lines = [];
    for (const raw of readFileSync(path, "utf8").split("\n")) {
        if (!raw.trim())
            continue;
        let entry;
        try {
            entry = JSON.parse(raw);
        }
        catch {
            continue;
        }
        if (entry.payload && typeof entry.payload === "object") {
            const line = codexLine(entry.payload);
            if (line)
                lines.push(line);
            continue;
        }
        if (entry.type !== "user" && entry.type !== "assistant")
            continue;
        const content = entry.message?.content;
        const text = typeof content === "string"
            ? content
            : (content ?? [])
                .filter((b) => b.type === "text" && b.text)
                .map((b) => b.text)
                .join("\n");
        if (text.trim())
            lines.push(`${entry.type === "user" ? "User" : "Assistant"}: ${text.trim()}`);
    }
    const full = lines.join("\n\n");
    if (full.length <= maxChars)
        return full;
    const head = Math.floor(maxChars * 0.4);
    const tail = maxChars - head;
    return `${full.slice(0, head)}\n\n[... ${full.length - maxChars} characters omitted ...]\n\n${full.slice(-tail)}`;
}
