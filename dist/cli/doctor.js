import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { allScopes } from "../periods.js";
import { pending } from "../rollup/index.js";
import { isOrphan, isSkipped, parseSession } from "../sessions/note.js";
import { EVENTS } from "./install.js";
import { readNightlyState } from "./nightly.js";
import { listMarkdown, noteName, readNote } from "../store/note.js";
const OPEN_TOO_LONG_MS = 2 * 24 * 3600 * 1000;
const STALLED_MS = 36 * 3600 * 1000;
/** Which atlas hooks Claude Code runs, read from its settings file. */
export function installedHooks(settingsPath = join(homedir(), ".claude", "settings.json")) {
    if (!existsSync(settingsPath))
        return undefined;
    let hooks;
    try {
        hooks = JSON.parse(readFileSync(settingsPath, "utf8")).hooks;
    }
    catch {
        return undefined;
    }
    const found = EVENTS.filter(([event, arg]) => (hooks?.[event] ?? []).some((e) => (e.hooks ?? []).some((h) => new RegExp(`\\bhook\\s+${arg}\\b`).test(h.command ?? "") && /temporal-atlas|cli[\\/]main\.js/.test(h.command ?? "")))).map(([event]) => event);
    return found.length ? found : undefined;
}
export function doctor(atlas, opts = {}) {
    const root = atlas.root;
    const files = listMarkdown(join(root, "scopes")).concat(listMarkdown(join(root, "index")));
    const names = new Set(files.map(noteName));
    const problems = [];
    const links = new Set();
    for (const f of files) {
        const n = readNote(f);
        if (n.error)
            problems.push(`${f.slice(root.length + 1)}: frontmatter does not parse (${n.error})`);
        if (n.fm.atlas === "topic")
            names.add(String(n.fm.topic));
        for (const m of n.body.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g))
            links.add(m[1].trim());
    }
    const now = atlas.now().getTime();
    const orphans = [];
    const openSessions = [];
    let skipped = 0;
    const scopes = allScopes(atlas);
    for (const scope of scopes) {
        for (const p of listMarkdown(atlas.paths.sessionsDir(scope))) {
            const note = readNote(p);
            if (note.error)
                continue;
            const s = parseSession(note);
            if (isSkipped(s))
                skipped++;
            if (isOrphan(s))
                orphans.push(noteName(p));
            const started = Date.parse(String(s.fm.started));
            if (s.fm.status === "open" && now - started > OPEN_TOO_LONG_MS)
                openSessions.push(noteName(p));
        }
    }
    const staleLocks = [];
    const locks = atlas.paths.locksDir;
    if (existsSync(locks)) {
        for (const f of readdirSync(locks)) {
            const at = Date.parse(JSON.parse(readFileSync(join(locks, f), "utf8")).at);
            if (now - at > 30 * 60 * 1000 || now - statSync(join(locks, f)).mtimeMs > 30 * 60 * 1000)
                staleLocks.push(f);
        }
    }
    const pend = scopes.map((scope) => {
        const p = pending(atlas, [scope]);
        return { scope, count: p.items.length, tokens: p.totalTokens, stale: p.items.filter((i) => i.stale).length };
    });
    const hooks = installedHooks(opts.settingsPath);
    const warnings = [];
    const backlog = pend.reduce((sum, p) => sum + p.tokens, 0);
    const count = pend.reduce((sum, p) => sum + p.count, 0);
    const lastTidy = lastTidyRun(atlas);
    const nightly = readNightlyState(root);
    if (atlas.config.rollups === "nightly") {
        const { maxTokens } = atlas.config.tidy;
        // The schedule catches up at login, so more than a day and a half without a run means it is not firing.
        const since = nightly.lastRunAt ?? nightly.installedAt;
        const stalled = since !== undefined && now - Date.parse(since) > STALLED_MS;
        if (count && since === undefined) {
            warnings.push(`${count} rollups are waiting and there is no record of the nightly run. Run \`temporal-atlas install nightly\` again: schedules from before 0.3 do not catch up when the computer was off at the set time.`);
        }
        else if (count && stalled) {
            const what = nightly.lastRunAt ? `has not run since ${nightly.lastRunAt.slice(0, 10)}` : `has not run since it was installed on ${since.slice(0, 10)}`;
            warnings.push(`${count} rollups are waiting and the nightly run ${what}. Check .atlas/tidy.out, run \`temporal-atlas install nightly\` again, or run \`temporal-atlas tidy\`.`);
        }
        else if (backlog > maxTokens) {
            warnings.push(`${count} rollups are waiting (about ${backlog} tokens), more than one night's ${maxTokens}-token budget, so the nightly run will take several nights. Run \`temporal-atlas tidy\` to start now.`);
        }
    }
    else if (backlog > atlas.config.costGateTokens) {
        warnings.push(`${count} rollups are waiting (about ${backlog} tokens, over the ${atlas.config.costGateTokens}-token cost gate), so briefs show drafts. Ask your agent to tidy the atlas, run \`temporal-atlas tidy\`, or schedule it with \`temporal-atlas install nightly\`.`);
    }
    if (orphans.length) {
        warnings.push(`${orphans.length} session(s) have a transcript but no record. Run \`temporal-atlas backfill\` to record them from their transcripts (no model, no cost).`);
    }
    if (hooks && !hooks.includes("Stop")) {
        warnings.push("The Claude Code hooks are from an older version and do not record activity after each turn. Run `temporal-atlas install claude-code` again.");
    }
    if (openSessions.length)
        warnings.push(`${openSessions.length} session(s) have been open for more than 2 days.`);
    return {
        atlasDir: root,
        scopes,
        notes: files.length,
        pending: pend,
        orphans,
        openSessions,
        unresolvedLinks: [...links].filter((l) => !names.has(l)).sort(),
        staleLocks,
        skipped,
        rollups: atlas.config.rollups,
        tidyAt: atlas.config.tidy.at,
        lastTidy: lastTidy === undefined ? undefined : atlas.stamp(new Date(lastTidy)),
        lastScheduled: nightly.lastRunAt,
        hooks,
        problems,
        warnings,
    };
}
export function formatDoctor(r) {
    const lines = [`Atlas: ${r.atlasDir}`, `Scopes: ${r.scopes.join(", ") || "none"}`, `Notes: ${r.notes}`, ""];
    const pend = r.pending.filter((p) => p.count);
    lines.push(pend.length ? "Pending rollups:" : "Pending rollups: none");
    for (const p of pend)
        lines.push(`  ${p.scope}: ${p.count} (about ${p.tokens} tokens${p.stale ? `, ${p.stale} stale` : ""})`);
    if (r.orphans.length)
        lines.push(`Sessions with a transcript but no record: ${r.orphans.length}`);
    if (r.skipped)
        lines.push(`Sessions skipped by capture (headless runs, empty transcripts): ${r.skipped}`);
    lines.push(`Claude Code hooks: ${r.hooks ? r.hooks.join(", ") : "not installed"}`);
    if (r.rollups === "nightly")
        lines.push(`Rollups: nightly at ${r.tidyAt}; last scheduled run: ${r.lastScheduled ?? "none yet"}; last rollup written: ${r.lastTidy ?? "none yet"}`);
    if (r.openSessions.length)
        lines.push(`Sessions open for more than 2 days: ${r.openSessions.join(", ")}`);
    if (r.unresolvedLinks.length)
        lines.push(`Links to notes that do not exist (often topics not yet written): ${r.unresolvedLinks.slice(0, 15).join(", ")}${r.unresolvedLinks.length > 15 ? ", ..." : ""}`);
    if (r.staleLocks.length)
        lines.push(`Expired rollup locks (safe to ignore): ${r.staleLocks.length}`);
    if (r.warnings.length)
        lines.push("", `Warnings:\n${r.warnings.map((w) => `  - ${w}`).join("\n")}`);
    if (r.problems.length)
        lines.push("", `Problems:\n${r.problems.map((p) => `  ${p}`).join("\n")}`);
    if (!r.problems.length && !r.warnings.length)
        lines.push("", "No problems found.");
    return lines.join("\n");
}
/** When the last tidy run wrote to .atlas/tidy.log, in milliseconds, or undefined if it never has. */
function lastTidyRun(atlas) {
    const file = atlas.paths.tidyLog;
    if (!existsSync(file))
        return undefined;
    const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    const last = lines.at(-1);
    if (!last)
        return undefined;
    try {
        const at = Date.parse(JSON.parse(last).at);
        return Number.isNaN(at) ? undefined : at;
    }
    catch {
        return undefined;
    }
}
