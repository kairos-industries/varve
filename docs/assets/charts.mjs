#!/usr/bin/env node
// Draws the README figures from the benchmark reports in docs/benchmark/, in a light and a
// dark version each, into docs/assets/. Run after updating a report: node docs/assets/charts.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const report = (name) => JSON.parse(readFileSync(join(root, "docs", "benchmark", `${name}.json`), "utf8"));
const out = join(root, "docs", "assets");
mkdirSync(out, { recursive: true });

const THEMES = {
  light: {
    surface: "#fcfcfb",
    ink: "#0b0b0b",
    ink2: "#52514e",
    muted: "#898781",
    grid: "#e1e0d9",
    axis: "#c3c2b7",
    accent: "#2a78d6",
    neutral: "#c3c2b7",
    // Ordinal blue ramp, session (lightest) to year (darkest); no step lighter than 250 on this surface.
    layers: ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#104281"],
  },
  dark: {
    surface: "#1a1a19",
    ink: "#f0efec",
    ink2: "#c3c2b7",
    muted: "#898781",
    grid: "#2c2c2a",
    axis: "#383835",
    accent: "#3987e5",
    neutral: "#5c5b56",
    // Same ramp, lightest for the year; no step darker than 600 on this surface.
    layers: ["#184f95", "#256abf", "#3987e5", "#6da7ec", "#b7d3f6"],
  },
};

const FONT = `system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const text = (x, y, s, { size = 13, fill, weight = 400, anchor = "start", extra = "" } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${extra}>${esc(s)}</text>`;

/** A horizontal bar from x0, square at the baseline and rounded 4px at the data end. */
function bar(x0, y, w, h, fill) {
  if (w <= 0) return "";
  const r = Math.min(4, w, h / 2);
  return `<path d="M${x0},${y} H${x0 + w - r} Q${x0 + w},${y} ${x0 + w},${y + r} V${y + h - r} Q${x0 + w},${y + h} ${x0 + w - r},${y + h} H${x0} Z" fill="${fill}"/>`;
}

function svg(width, height, t, body, label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}" font-family='${FONT}'>
<rect width="${width}" height="${height}" rx="12" fill="${t.surface}"/>
${body}
</svg>
`;
}

// ---- hero: the five layers over four weeks ----

function hero(t) {
  const W = 1200;
  const H = 410;
  const parts = [];
  parts.push(text(64, 104, "MCP SERVER FOR CLAUDE CODE, CODEX AND ANY MCP CLIENT", { size: 13, fill: t.muted, weight: 600, extra: ` letter-spacing="1.2"` }));
  parts.push(text(60, 178, "Varve", { size: 68, fill: t.ink, weight: 700, extra: ` letter-spacing="-1.5"` }));
  parts.push(text(64, 228, "Your coding agent's memory of past work,", { size: 24, fill: t.ink2 }));
  parts.push(text(64, 260, "layered by time and by topic.", { size: 24, fill: t.ink2 }));
  parts.push(text(64, 324, "Plain Markdown on your disk  ·  no API key  ·  no cloud", { size: 15, fill: t.muted }));

  // Four weeks of work, Monday 7 September to Friday 2 October, as it rolls up.
  const x0 = 690;
  const span = 400;
  const days = 26;
  const dx = span / days;
  const lanes = [
    { name: "year", note: "~800 tokens" },
    { name: "month", note: "~400 tokens" },
    { name: "week", note: "~500 tokens" },
    { name: "day", note: "~600 tokens" },
    { name: "session", note: "full detail" },
  ];
  const top = 104;
  const laneH = 44;
  const h = 18;
  // A topic is a core taken through every layer: one subject, from the sessions up to the year.
  // Drawn first, so the layers sit on top of it.
  const coreX = x0 + 9 * dx - 6;
  const coreW = 3 * dx + 12;
  parts.push(`<rect x="${coreX.toFixed(1)}" y="${top - 10}" width="${coreW.toFixed(1)}" height="${lanes.length * laneH - 4}" rx="8" fill="${t.accent}" fill-opacity="0.12" stroke="${t.accent}" stroke-width="1.5" stroke-dasharray="0"/>`);
  parts.push(text(coreX + coreW / 2, top - 18, "topic: Auth design", { size: 12, fill: t.ink2, anchor: "middle", weight: 600 }));
  lanes.forEach((lane, i) => {
    const y = top + i * laneH;
    const fill = t.layers[4 - i];
    parts.push(text(x0 - 16, y + 13, lane.name, { size: 13, fill: t.ink2, anchor: "end", weight: 600 }));
    parts.push(text(x0 + span + 14, y + 13, lane.note, { size: 12, fill: t.muted }));
    const blocks = [];
    if (lane.name === "year") blocks.push([0, days]);
    if (lane.name === "month") blocks.push([0, 18], [18, days]);
    if (lane.name === "week") for (let w = 0; w < 4; w++) blocks.push([w * 7, Math.min(days, w * 7 + 5)]);
    if (lane.name === "day") for (let d = 0; d < days; d++) if (d % 7 < 5) blocks.push([d, d + 1]);
    if (lane.name === "session") {
      // A fixed, irregular pattern: one to three sessions on a working day.
      const per = [2, 3, 1, 2, 1, 0, 0, 3, 1, 2, 2, 1, 0, 0, 1, 3, 2, 1, 2, 0, 0, 2, 1, 3, 1, 2];
      per.forEach((n, d) => {
        for (let k = 0; k < n; k++) blocks.push([d + k / n + 0.06, d + (k + 1) / n - 0.06]);
      });
    }
    for (const [a, b] of blocks) {
      const gap = lane.name === "session" ? 0 : 1;
      const w = (b - a) * dx - gap * 2;
      parts.push(`<rect x="${(x0 + a * dx + gap).toFixed(1)}" y="${y}" width="${Math.max(2, w).toFixed(1)}" height="${h}" rx="4" fill="${fill}"/>`);
    }
  });
  const axisY = top + lanes.length * laneH + 6;
  parts.push(`<line x1="${x0}" y1="${axisY}" x2="${x0 + span}" y2="${axisY}" stroke="${t.axis}" stroke-width="1"/>`);
  ["Sep 7", "Sep 14", "Sep 21", "Sep 28"].forEach((l, w) => parts.push(text(x0 + w * 7 * dx, axisY + 18, l, { size: 11, fill: t.muted })));
  return svg(W, H, t, parts.join("\n"), "Varve: sessions roll up into day, week, month and year notes, each shorter than the one below");
}

// ---- search quality: how often the answer is found, with 95% intervals ----

const pct = (v) => `${Math.round(v * 100)}%`;

function rows(width, items, t, { labelW = 330, valueW = 70 } = {}) {
  const plotX = labelW;
  const plotW = width - labelW - valueW - 32;
  const rowH = 34;
  const parts = [];
  items.forEach((it, i) => {
    const y = i * rowH;
    const w = it.value * plotW;
    parts.push(text(plotX - 14, y + 14, it.label, { size: 13, fill: t.ink, anchor: "end", weight: 600 }));
    parts.push(bar(plotX, y + 2, w, 18, t.accent));
    if (it.ci) {
      const [lo, hi] = it.ci.map((v) => plotX + v * plotW);
      parts.push(`<path d="M${lo},${y + 11} H${hi} M${lo},${y + 6} V${y + 16} M${hi},${y + 6} V${y + 16}" stroke="${t.ink}" stroke-width="1.5" fill="none"/>`);
    }
    const end = plotX + Math.max(w, it.ci ? it.ci[1] * plotW : 0);
    parts.push(text(end + 10, y + 15, pct(it.value), { size: 13, fill: t.ink, weight: 700 }));
  });
  return { svg: parts.join("\n"), height: items.length * rowH, plotX, plotW };
}

function axis(t, plotX, plotW, y0, height, ticks = [0, 0.25, 0.5, 0.75, 1]) {
  const parts = [];
  for (const v of ticks) {
    const x = plotX + v * plotW;
    parts.push(`<line x1="${x}" y1="${y0 - 6}" x2="${x}" y2="${y0 + height}" stroke="${v === 0 ? t.axis : t.grid}" stroke-width="1"/>`);
    parts.push(text(x, y0 + height + 18, pct(v), { size: 11, fill: t.muted, anchor: "middle" }));
  }
  return parts.join("\n");
}

function searchQuality(t) {
  const fixture = report("fixture-0.5.0").retrieval;
  const author = report("author-0.5.0").retrieval;
  const W = 880;
  const datasets = [
    { label: `Real work: the author's atlas, ${author.all.probes} questions`, r: author.all },
    { label: "Hard test: 36 held-out questions", r: fixture.test },
    { label: "Hard test: all 69 questions", r: fixture.all },
  ];
  const panels = [
    { title: "Answer in the first five results", items: datasets.map((d) => ({ label: d.label, value: d.r.hybrid.hit5, ci: d.r.hybrid.hit5Ci })) },
    { title: "Answer as the first result", items: datasets.map((d) => ({ label: d.label, value: d.r.hybrid.hit1 })) },
  ];
  const parts = [];
  parts.push(text(32, 44, "How often search finds the right note", { size: 20, fill: t.ink, weight: 700 }));
  parts.push(text(32, 68, "Default search (keyword + meaning), Varve 0.5.0. Whiskers: 95% bootstrap interval.", { size: 13, fill: t.ink2 }));
  let y = 112;
  for (const p of panels) {
    parts.push(text(32, y, p.title, { size: 14, fill: t.ink, weight: 600 }));
    y += 18;
    const r = rows(W, p.items, t);
    parts.push(axis(t, r.plotX, r.plotW, y, r.height));
    parts.push(`<g transform="translate(0 ${y})">${r.svg}</g>`);
    y += r.height + 52;
  }
  const H = y - 10;
  return svg(W, H, t, parts.join("\n"), `Bar chart: the answer is in the first five results for ${pct(author.all.hybrid.hit5)} of ${author.all.probes} questions on the author's atlas, ${pct(fixture.test.hybrid.hit5)} of held-out hard questions and ${pct(fixture.all.hybrid.hit5)} of all hard questions; first for ${pct(author.all.hybrid.hit1)}, ${pct(fixture.test.hybrid.hit1)} and ${pct(fixture.all.hybrid.hit1)}`);
}

// ---- headline: search on the author's atlas ----

function headline(t) {
  const real = report("author-0.5.0");
  const fixture = report("fixture-0.5.0").retrieval;
  const r = real.retrieval.all;
  const W = 880;
  const H = 440;
  const parts = [];
  parts.push(text(32, 48, "Search on four weeks of real work", { size: 22, fill: t.ink, weight: 700 }));
  parts.push(text(32, 74, `${r.probes} questions about ${real.atlas.sessions} sessions in ${real.atlas.scopes} projects: decisions, findings, summaries and names. Default search, Varve ${real.version}.`, { size: 13, fill: t.ink2 }));

  // Two big tiles: the answer in the top five, and the answer first.
  const tiles = [
    { value: r.hybrid.hit5, label: "of questions find the answer in the first five results" },
    { value: r.hybrid.hit1, label: "find it as the very first result" },
  ];
  const tileW = 400;
  tiles.forEach((tile, i) => {
    const x = 32 + i * (tileW + 16);
    const y = 100;
    parts.push(`<rect x="${x}" y="${y}" width="${tileW}" height="176" rx="12" fill="none" stroke="${t.grid}" stroke-width="1.5"/>`);
    parts.push(text(x + 24, y + 92, pct(tile.value), { size: 84, fill: t.accent, weight: 700, extra: ` letter-spacing="-2"` }));
    parts.push(text(x + 24, y + 124, tile.label, { size: 14, fill: t.ink2 }));
    const barW = tileW - 48;
    parts.push(`<rect x="${x + 24}" y="${y + 146}" width="${barW}" height="8" rx="4" fill="${t.grid}"/>`);
    parts.push(`<rect x="${x + 24}" y="${y + 146}" width="${(barW * tile.value).toFixed(1)}" height="8" rx="4" fill="${t.accent}"/>`);
  });

  // Three smaller facts underneath.
  const exact = real.retrieval.exact;
  const facts = [
    { value: `${Math.round(r.hybrid.ms)} ms`, label: "median time per search" },
    { value: pct(exact.hybrid.hit5), label: `of ${exact.probes} exact names found in the top five` },
    { value: "0", label: "network calls: search runs on your machine" },
  ];
  const factW = (W - 64) / facts.length;
  facts.forEach((f, i) => {
    const x = 32 + i * factW;
    parts.push(text(x, 336, f.value, { size: 34, fill: t.ink, weight: 700 }));
    parts.push(text(x, 362, f.label, { size: 13, fill: t.ink2 }));
  });

  parts.push(`<line x1="32" y1="388" x2="${W - 32}" y2="388" stroke="${t.grid}" stroke-width="1"/>`);
  parts.push(text(32, 414, `These questions reuse words from their notes. On the reworded hard test below: ${pct(fixture.test.hybrid.hit5)} held out, ${pct(fixture.all.hybrid.hit5)} overall.`, { size: 12, fill: t.muted }));
  return svg(W, H, t, parts.join("\n"), `Search on four weeks of real work: ${pct(r.hybrid.hit5)} of 200 questions find the answer in the first five results, ${pct(r.hybrid.hit1)} as the first result, in ${Math.round(r.hybrid.ms)} ms; ${pct(exact.hybrid.hit5)} of ${exact.probes} exact names in the top five`);
}

// ---- by kind: 0.3.1 against now ----

function byKind(t) {
  const now = report("fixture-0.5.0").retrieval;
  const before = report("fixture-0.3.1-behaviour").retrieval;
  const W = 880;
  const kinds = [
    { key: "paraphrase", label: "Reworded" },
    { key: "exact", label: "Exact name or term" },
    { key: "dated", label: "Date range" },
  ];
  const parts = [];
  parts.push(text(32, 44, "By kind of question", { size: 20, fill: t.ink, weight: 700 }));
  parts.push(text(32, 68, "Answer in the first five results, all 69 hard-test questions.", { size: 13, fill: t.ink2 }));
  // Legend: two series, so always present.
  const ly = 96;
  parts.push(`<rect x="32" y="${ly - 10}" width="12" height="12" rx="3" fill="${t.neutral}"/>`);
  parts.push(text(50, ly, "0.3.1 (keyword only)", { size: 12, fill: t.ink2 }));
  parts.push(`<rect x="202" y="${ly - 10}" width="12" height="12" rx="3" fill="${t.accent}"/>`);
  parts.push(text(220, ly, "0.5.0 (keyword + meaning, the default)", { size: 12, fill: t.ink2 }));
  const labelW = 210;
  const plotX = labelW;
  const plotW = W - labelW - 70 - 32;
  const groupH = 70;
  const y0 = 128;
  parts.push(axis(t, plotX, plotW, y0, kinds.length * groupH - 14));
  kinds.forEach((k, i) => {
    const y = y0 + i * groupH;
    const n = now[k.key].probes;
    parts.push(text(plotX - 14, y + 22, k.label, { size: 13, fill: t.ink, anchor: "end", weight: 600 }));
    parts.push(text(plotX - 14, y + 38, `${n} questions`, { size: 11, fill: t.muted, anchor: "end" }));
    const a = before[k.key].keyword.hit5;
    const b = now[k.key].hybrid.hit5;
    // Two touching bars, separated by a 2px surface gap.
    parts.push(bar(plotX, y + 4, a * plotW, 18, t.neutral));
    parts.push(bar(plotX, y + 24, b * plotW, 18, t.accent));
    parts.push(text(plotX + a * plotW + 8, y + 18, pct(a), { size: 12, fill: t.ink2 }));
    parts.push(text(plotX + b * plotW + 8, y + 38, pct(b), { size: 12, fill: t.ink, weight: 700 }));
  });
  const H = y0 + kinds.length * groupH + 30;
  return svg(W, H, t, parts.join("\n"), "Grouped bar chart, answer in the first five results: reworded questions 54% in 0.3.1 and 71% now, exact names 100% and 100%, date ranges 20% and 60%");
}

for (const [mode, t] of Object.entries(THEMES)) {
  writeFileSync(join(out, `hero-${mode}.svg`), hero(t));
  writeFileSync(join(out, `headline-${mode}.svg`), headline(t));
  writeFileSync(join(out, `search-quality-${mode}.svg`), searchQuality(t));
  writeFileSync(join(out, `by-kind-${mode}.svg`), byKind(t));
}
console.log(`Wrote 8 figures to ${out}`);
