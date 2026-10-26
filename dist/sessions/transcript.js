import { existsSync, readFileSync } from "node:fs";
/**
 * Pull the human-readable conversation out of a Claude Code JSONL transcript,
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
