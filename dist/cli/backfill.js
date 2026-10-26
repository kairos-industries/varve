import { existsSync, rmSync } from "node:fs";
import { captureTranscript, hasActivity, isHeadless, renderActivity } from "../capture/index.js";
import { isInside } from "../config.js";
import { allScopes, refreshAround } from "../periods.js";
import { GENERAL } from "../scopes/index.js";
import { mergeScope } from "../scopes/manage.js";
import { hasContent, isSkipped, parseSession, saveSession, segmentFor } from "../sessions/note.js";
import { listMarkdown, noteName, readNote, writeFrontmatter } from "../store/note.js";
/**
 * Bring sessions recorded before activity capture up to date, without a model: build their
 * Activity sections from the transcripts, keep one note per conversation, skip headless runs,
 * and fold scopes that only ever ran in app scratch folders into the general scope.
 */
export function backfill(atlas, opts = {}) {
    const dryRun = Boolean(opts.dryRun);
    const report = { captured: [], duplicates: [], headless: [], empty: [], missing: [], merged: [], dryRun };
    const generalFolders = atlas.config.capture.generalPaths;
    const touched = new Map();
    const counts = new Map();
    const count = (scope, inGeneral) => {
        const c = counts.get(scope) ?? { sessions: 0, inGeneral: 0 };
        c.sessions++;
        if (inGeneral)
            c.inGeneral++;
        counts.set(scope, c);
    };
    const skip = (f, reason, prunable) => {
        if (dryRun)
            return;
        if (prunable && opts.prune)
            rmSync(f.path);
        else
            writeFrontmatter(readNote(f.path), { capture: "skipped", skipped_reason: reason });
    };
    // Group notes by transcript: one conversation, however many times it was reopened, is one note.
    const byTranscript = new Map();
    for (const scope of allScopes(atlas)) {
        for (const path of listMarkdown(atlas.paths.sessionsDir(scope))) {
            const note = readNote(path);
            if (!note || note.error)
                continue;
            const session = parseSession(note);
            if (isSkipped(session))
                continue;
            const transcript = typeof session.fm.transcript === "string" ? session.fm.transcript : undefined;
            if (!transcript) {
                const origin = session.fm.origin_kind === "path" && typeof session.fm.origin === "string" ? session.fm.origin : undefined;
                count(scope, Boolean(origin && isInside(origin, generalFolders)));
                continue;
            }
            byTranscript.set(transcript, [...(byTranscript.get(transcript) ?? []), { scope, path, session }]);
        }
    }
    for (const [transcript, notes] of byTranscript) {
        notes.sort((a, b) => Number(b.session.segments.some((x) => x.activity)) - Number(a.session.segments.some((x) => x.activity)) || String(a.session.fm.started).localeCompare(String(b.session.fm.started)));
        const main = notes[0];
        const rest = notes.slice(1);
        const recorded = main.session.segments.some((x) => x.activity);
        const agentWrote = (f) => f.session.segments.some((x) => x.headline || x.summary || x.events.length);
        if (!existsSync(transcript)) {
            if (!recorded)
                report.missing.push(...notes.map((n) => noteName(n.path)));
            for (const n of notes)
                count(n.scope, false);
            continue;
        }
        const state = recorded ? undefined : captureTranscript(transcript, atlas.config);
        const cwd = state?.cwd ?? (main.session.fm.origin_kind === "path" ? String(main.session.fm.origin) : undefined);
        const inGeneral = Boolean(cwd && isInside(cwd, generalFolders));
        if (state && isHeadless(state) && !atlas.config.capture.headless) {
            for (const n of notes) {
                if (agentWrote(n)) {
                    count(n.scope, inGeneral);
                    continue;
                }
                report.headless.push(noteName(n.path));
                skip(n, "headless", true);
            }
            continue;
        }
        for (const n of rest) {
            if (agentWrote(n) || n.session.segments.some(hasContent)) {
                count(n.scope, inGeneral);
                continue;
            }
            report.duplicates.push(noteName(n.path));
            skip(n, `same conversation as ${noteName(main.path)}`, true);
        }
        count(main.scope, inGeneral);
        if (recorded || !state)
            continue;
        if (!hasActivity(state)) {
            if (!agentWrote(main)) {
                report.empty.push(noteName(main.path));
                skip(main, "no requests in the transcript", false);
            }
            continue;
        }
        report.captured.push(noteName(main.path));
        if (dryRun)
            continue;
        const days = atlas.withNote(main.path, () => {
            const fresh = parseSession(readNote(main.path));
            const changed = [];
            for (const day of Object.keys(state.days).sort()) {
                const text = renderActivity(state, day);
                if (!text)
                    continue;
                segmentFor(fresh, day).activity = atlas.scrub(text);
                changed.push(day);
            }
            if (state.title)
                fresh.fm.title = atlas.scrub(state.title);
            saveSession(fresh);
            return changed;
        });
        // A later resume of this conversation continues in the same note, from where backfill stopped.
        const clientId = main.session.fm.client_session_id;
        if (typeof clientId === "string" && !atlas.readCapture(clientId)) {
            atlas.writeCapture(clientId, { ...state, noteId: String(main.session.fm.session), notePath: main.path });
        }
        const set = touched.get(main.scope) ?? new Set();
        for (const d of days)
            set.add(d);
        touched.set(main.scope, set);
    }
    for (const [scope, c] of counts) {
        if (scope !== GENERAL && c.sessions > 0 && c.inGeneral === c.sessions)
            report.merged.push(scope);
    }
    report.merged.sort();
    if (dryRun)
        return report;
    for (const [scope, days] of touched) {
        atlas.markDaysStale(scope, [...days]);
        if (!report.merged.includes(scope))
            refreshAround(atlas, scope, [...days]);
    }
    for (const scope of report.merged)
        mergeScope(atlas, scope, GENERAL);
    return report;
}
export function formatBackfill(r) {
    const verb = r.dryRun ? "Would" : "Did";
    return [
        `${verb} record activity from transcripts: ${r.captured.length} session(s)`,
        `${verb} fold reopened conversations into one note: ${r.duplicates.length} extra note(s) skipped`,
        `${verb} skip headless runs (claude -p and similar): ${r.headless.length}`,
        `${verb} skip transcripts with no request: ${r.empty.length}`,
        `${verb} merge into general (sessions all in app scratch folders): ${r.merged.length ? r.merged.join(", ") : "none"}`,
        r.missing.length ? `Transcripts no longer on disk: ${r.missing.length}` : "",
        r.dryRun ? "\nNothing was written. Run without --dry-run to apply." : "",
    ]
        .filter(Boolean)
        .join("\n");
}
