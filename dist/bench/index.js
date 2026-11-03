import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBrief } from "../brief.js";
import { tokens } from "../config.js";
import { MODEL, embedder as installedEmbedder } from "../embed/index.js";
import { allScopes } from "../periods.js";
import { MIN_SIMILARITY, search } from "../search.js";
import { isSkipped, parseSession } from "../sessions/note.js";
import { listMarkdown, noteName, readNote } from "../store/note.js";
import { VERSION } from "../version.js";
import { buildFixture, FIXTURE_QUESTIONS } from "./fixture.js";
const round = (n, places = 3) => Math.round(n * 10 ** places) / 10 ** places;
const median = (xs) => {
    if (!xs.length)
        return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
};
function scoreMode(atlas, probes, mode, model, minSimilarity) {
    let hit1 = 0;
    let hit5 = 0;
    let rr = 0;
    const times = [];
    for (const p of probes) {
        const t = performance.now();
        const results = search(atlas, { query: p.query, scopes: p.scopes, layer: p.layer, from: p.from, to: p.to, limit: 10 }, { mode, embedder: model, minSimilarity });
        times.push(performance.now() - t);
        const rank = results.findIndex((r) => p.relevant.includes(r.note));
        if (rank === 0)
            hit1++;
        if (rank >= 0 && rank < 5)
            hit5++;
        if (rank >= 0)
            rr += 1 / (rank + 1);
    }
    const n = probes.length || 1;
    return { hit1: round(hit1 / n), hit5: round(hit5 / n), mrr: round(rr / n), ms: round(median(times), 1) };
}
/** Score every probe kind, and all of them together, in each search mode the model allows. */
export function retrieval(atlas, probes, model) {
    const modes = model ? ["keyword", "semantic", "hybrid"] : ["keyword"];
    const kinds = [...new Set(probes.map((p) => p.kind))].sort();
    const out = {};
    for (const kind of [...kinds, "all"]) {
        const set = kind === "all" ? probes : probes.filter((p) => p.kind === kind);
        if (!set.length)
            continue;
        out[kind] = { probes: set.length };
        for (const mode of modes)
            out[kind][mode] = scoreMode(atlas, set, mode, model);
    }
    return out;
}
const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
/**
 * Does the brief carry what is still open? For each scope with recent work: the todos logged in
 * the last `days` days, and how many of them the brief shows (the first 50 characters, as written).
 */
export function briefCheck(atlas, scopes, days = 14) {
    const today = atlas.today();
    const since = new Date(new Date(`${today}T12:00:00Z`).getTime() - days * 86400000).toISOString().slice(0, 10);
    const sizes = [];
    const times = [];
    let todos = 0;
    let shown = 0;
    for (const scope of scopes) {
        const sessions = atlas.sessionNotes(scope).filter((s) => !isSkipped(s));
        const recent = sessions.flatMap((s) => s.segments).filter((seg) => seg.day >= since && seg.day <= today);
        if (!recent.length)
            continue;
        const t = performance.now();
        const brief = norm(buildBrief(atlas, { scope, visible: [scope], capTokens: atlas.config.briefTokens.tool }));
        times.push(performance.now() - t);
        sizes.push(tokens(brief));
        for (const seg of recent) {
            for (const e of seg.events.filter((x) => x.type === "todo")) {
                todos++;
                if (brief.includes(norm(e.text).slice(0, 50)))
                    shown++;
            }
        }
    }
    return {
        scopes: sizes.length,
        tokensMean: Math.round(sizes.reduce((a, b) => a + b, 0) / (sizes.length || 1)),
        tokensMax: Math.max(0, ...sizes),
        ms: round(median(times), 1),
        todos,
        todoRecall: todos ? round(shown / todos) : null,
    };
}
function atlasStats(atlas, scopes) {
    const notes = {};
    let sessions = 0;
    for (const scope of scopes) {
        for (const p of listMarkdown(atlas.paths.scopeDir(scope))) {
            const fm = readNote(p)?.fm;
            const layer = fm?.atlas === "session" ? "session" : fm?.atlas === "topic" ? "topic" : String(fm?.layer ?? "other");
            notes[layer] = (notes[layer] ?? 0) + 1;
            if (layer === "session")
                sessions++;
        }
    }
    return { scopes: scopes.length, sessions, notes };
}
function header(dataset, atlas, scopes, model) {
    return {
        benchmark: "temporal-atlas",
        version: VERSION,
        dataset,
        ranOn: new Date().toISOString().slice(0, 10),
        platform: process.platform,
        node: process.versions.node,
        model: model ? { name: MODEL.name, revision: MODEL.revision } : null,
        settings: { minSimilarity: MIN_SIMILARITY },
        atlas: atlasStats(atlas, scopes),
    };
}
export const SWEEP = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45];
export function sweep(atlas, probes, model) {
    return Object.fromEntries(SWEEP.map((t) => {
        const { ms: _ms, ...s } = scoreMode(atlas, probes, "hybrid", model, t);
        return [t.toFixed(2), s];
    }));
}
/** Run the fixture: build it in a temporary folder, score it, delete it. */
export function benchFixture(model = installedEmbedder(), opts = {}) {
    const root = mkdtempSync(join(tmpdir(), "atlas-bench-"));
    try {
        const { atlas, notes } = buildFixture(root);
        const scopes = allScopes(atlas);
        const probes = FIXTURE_QUESTIONS.map((q) => ({ ...q, relevant: q.relevant.map((k) => notes.get(k)), scopes }));
        return {
            ...header("fixture", atlas, scopes, model),
            retrieval: retrieval(atlas, probes, model),
            ...(opts.sweep && model ? { sweep: sweep(atlas, probes, model) } : {}),
            brief: briefCheck(atlas, scopes),
        };
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
}
/** A query someone might type for an event: its first clause, at most eight words. */
export function eventQuery(text) {
    const clause = text.split(/[;:—]|, (?:so|because|but|which)\b|\. /)[0];
    return clause.split(/\s+/).filter(Boolean).slice(0, 8).join(" ").replace(/[.,]$/, "");
}
/** A stable order that does not follow note dates, so a capped sample spreads over the whole atlas. */
const shuffleKey = (s) => createHash("sha256").update(s).digest("hex");
/**
 * Probes from the user's own atlas, searched within the probe's own scope as an agent there would.
 * event: a logged decision, finding or change, to find its session (known-item search: the words
 * are in the note, so this flatters keyword search). summary: a sealed day or week headline, to
 * find the notes it was written from (the headline is new wording).
 */
export function ownProbes(atlas, scopes, max = 200) {
    const probes = [];
    for (const scope of scopes) {
        for (const p of listMarkdown(atlas.paths.sessionsDir(scope))) {
            const note = readNote(p);
            if (!note || note.error)
                continue;
            const s = parseSession(note);
            if (isSkipped(s))
                continue;
            for (const seg of s.segments) {
                for (const e of seg.events.filter((x) => x.type === "decision" || x.type === "finding" || x.type === "change")) {
                    const query = eventQuery(e.text);
                    if (query.split(" ").length >= 3)
                        probes.push({ query, relevant: [noteName(p)], kind: "event", scopes: [scope] });
                }
            }
        }
        for (const layer of ["days", "weeks"]) {
            for (const p of listMarkdown(join(atlas.paths.scopeDir(scope), layer))) {
                const fm = readNote(p)?.fm;
                if (fm?.status !== "sealed" || typeof fm.headline !== "string" || !Array.isArray(fm.sources) || !fm.sources.length)
                    continue;
                const relevant = fm.sources.map((x) => String(x).replace(/^\[\[|\]\]$/g, ""));
                probes.push({ query: fm.headline, relevant, kind: "summary", scopes: [scope], layer: layer === "days" ? "session" : "day" });
            }
        }
    }
    return probes.sort((a, b) => shuffleKey(a.query).localeCompare(shuffleKey(b.query))).slice(0, max);
}
export function benchOwn(atlas, opts = {}) {
    const model = opts.model ?? installedEmbedder();
    const scopes = allScopes(atlas);
    const probes = opts.probes ?? ownProbes(atlas, scopes, opts.max);
    return {
        ...header(opts.dataset ?? "own", atlas, scopes, model),
        retrieval: retrieval(atlas, probes, model),
        ...(opts.sweep && model ? { sweep: sweep(atlas, probes, model) } : {}),
        brief: briefCheck(atlas, scopes),
    };
}
const PARAPHRASE_PROMPT = `Each line below is a search query someone could type to find a note in their work log. Rewrite each one the way a colleague would ask about it from memory a few weeks later: same meaning, everyday words, and do not reuse the distinctive words (names, product terms, numbers) of the original unless there is no other way to say it.

Reply with a JSON array of strings only, one rewrite per line, in the same order.`;
export const PARAPHRASE_BATCH = 25;
/** Input tokens a paraphrase run sends, for the estimate shown before it runs. */
export function paraphraseTokens(probes) {
    const batches = Math.ceil(probes.length / PARAPHRASE_BATCH);
    return batches * tokens(PARAPHRASE_PROMPT) + probes.reduce((sum, p) => sum + tokens(p.query) + 2, 0);
}
/**
 * The optional paid tier: a model rewrites each query so that word overlap no longer helps.
 * Only the queries are sent (one clause of a logged event, or a summary headline), through the
 * user's own `claude` CLI, within `maxUsd`.
 */
export async function paraphrase(probes, runner, opts) {
    const out = [];
    let cost = 0;
    for (let i = 0; i < probes.length; i += PARAPHRASE_BATCH) {
        const batch = probes.slice(i, i + PARAPHRASE_BATCH);
        const left = opts.maxUsd - cost;
        if (left <= 0.005)
            break;
        const reply = await runner(`${PARAPHRASE_PROMPT}\n\n${batch.map((p) => p.query.replace(/\n/g, " ")).join("\n")}`, { model: opts.model, maxUsd: left });
        cost += reply.costUsd ?? 0;
        const json = /\[[\s\S]*\]/.exec(reply.text)?.[0];
        let rewrites;
        try {
            rewrites = json ? JSON.parse(json) : undefined;
        }
        catch {
            rewrites = undefined;
        }
        if (!Array.isArray(rewrites) || rewrites.length !== batch.length)
            continue;
        batch.forEach((p, j) => {
            const q = String(rewrites[j] ?? "").trim();
            if (q)
                out.push({ ...p, query: q });
        });
    }
    return { probes: out, costUsd: round(cost, 4) };
}
export function formatReport(r) {
    const lines = [
        `Temporal Atlas benchmark ${r.version}, ${r.dataset} dataset, ${r.ranOn}`,
        `Atlas: ${r.atlas.scopes} scopes, ${r.atlas.sessions} sessions. Search model: ${r.model ? r.model.name : "none (keyword only; run `temporal-atlas models pull`)"}`,
        "",
        "Search        probes  mode      hit@1  hit@5  MRR    ms",
    ];
    for (const [kind, v] of Object.entries(r.retrieval)) {
        for (const mode of ["keyword", "semantic", "hybrid"]) {
            const s = v[mode];
            if (!s)
                continue;
            lines.push(`${kind.padEnd(14)}${String(v.probes).padStart(6)}  ${mode.padEnd(9)} ${s.hit1.toFixed(2).padStart(5)}  ${s.hit5.toFixed(2).padStart(5)}  ${s.mrr.toFixed(2).padStart(5)} ${String(s.ms).padStart(5)}`);
        }
    }
    if (r.sweep) {
        lines.push("", "Similarity threshold (hybrid, all probes)  hit@1  hit@5  MRR");
        for (const [t, s] of Object.entries(r.sweep))
            lines.push(`  ${t}${t === r.settings.minSimilarity.toFixed(2) ? " (default)" : "          "}                        ${s.hit1.toFixed(2)}   ${s.hit5.toFixed(2)}   ${s.mrr.toFixed(2)}`);
    }
    if (r.brief) {
        const b = r.brief;
        lines.push("", `Brief: ${b.scopes} scopes with recent work, ${b.tokensMean} tokens on average (max ${b.tokensMax}), ${b.ms} ms`);
        lines.push(b.todoRecall === null ? "Open todos from the last 14 days: none logged" : `Open todos from the last 14 days shown in the brief: ${Math.round(b.todoRecall * 100)}% (${b.todos} todos)`);
    }
    if (r.paraphrase)
        lines.push("", `Paraphrased by ${r.paraphrase.model}: ${r.paraphrase.rewritten} queries, $${r.paraphrase.costUsd.toFixed(4)}`);
    return lines.join("\n");
}
