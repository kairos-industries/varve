# Benchmark

`temporal-atlas bench` measures how well Temporal Atlas brings back past work: whether search finds the note that answers a question, and whether the brief shows what is still open. It calls no model and only reads the atlas.

The numbers below are the baseline. Every report sent in adds a real atlas to the picture, and the defaults (search threshold, what goes in the brief) will be chosen from those reports.

## Run it

```sh
temporal-atlas models pull          # once, so search by meaning is scored too
temporal-atlas bench --fixture      # the bundled atlas: the same on every machine
temporal-atlas bench --sweep        # your own atlas, with the similarity threshold sweep
```

`bench` on your own atlas saves its report to `.atlas/bench/bench-<date>.json` in the atlas folder. The report holds numbers only: the version, platform, Node version, model id, counts of scopes, sessions and notes, and the scores. It never contains note text, project names or note names. A test fails if it ever does (`test/bench.test.ts`).

## Send your results

Open an issue with the **Benchmark result** template and paste the JSON. Say in a sentence how you use the atlas (Claude Code or Codex, nightly or agent rollups, how many weeks), since that is what the numbers depend on.

## What it measures

**Search.** Each probe is a query with the notes that answer it. The probe is searched three ways (keyword only, meaning only, both fused) and scored:

| Score | Meaning |
|---|---|
| hit@1 | The first result answers the query |
| hit@5 | An answer is in the first five results |
| MRR | Mean of 1 / rank of the first answer, within the first ten (0 if none) |
| ms | Median time per search |

**Brief.** For each scope with work in the last 14 days: the brief's size in tokens, the time to build it, and the share of todos logged in those 14 days that the brief shows.

**Sweep** (`--sweep`). Hybrid search at similarity thresholds from 0.20 to 0.45. Below the threshold, a note is not counted as a match by meaning.

## Datasets

**Fixture** (`--fixture`). An invented atlas: 26 sessions over four weeks in three projects (billing API, mobile app, data platform), and 33 questions written for it:

- 26 **paraphrase** questions, worded as a colleague would ask weeks later, sharing no distinctive word with the note they target ("the spreadsheet download we got rid of" for the CSV export removal).
- 6 **exact** lookups of a name or term (`VIES`, `LaunchDarkly`, `guideline 5.1.1`).
- 1 **dated** question, a vague query with a date range.

The fixture is in [src/bench/fixture.ts](src/bench/fixture.ts). Session ids are fixed, so every machine gets the same notes and the same scores.

**Your atlas.** Probes are built from what is already there:

- **event**: a logged decision, finding or change, cut to its first clause (at most eight words), to find the session that logged it. Each is searched within its own scope, as an agent working there would search. The query's words are in the target note, so this is known-item search, and it flatters keyword search.
- **summary**: a sealed day or week headline, to find the notes it was written from. The headline is new wording. These appear only once rollups are sealed.

At most 200 probes are used (`--max`), sampled evenly across the atlas.

**Paraphrased** (`--paraphrase`, optional, paid). A model rewords your atlas's queries the way a colleague would ask from memory, and the rewordings are scored. This removes the word-overlap advantage of event probes. It sends the queries (only the queries) through your own `claude` CLI, shows the estimate and asks first, and stops at `--max-usd` (default $0.25, model `haiku`).

## Results

### Fixture

Search model potion-base-8M at revision `bf8b056`, macOS, Node 24.

| Version, mode | Questions | hit@1 | hit@5 | MRR |
|---|---|---|---|---|
| 0.3.1, keyword | all 33 | 0.24 | 0.48 | 0.34 |
| 0.4.0, keyword | all 33 | 0.42 | 0.52 | 0.48 |
| 0.4.0, meaning | all 33 | 0.39 | 0.52 | 0.46 |
| **0.4.0, both (default)** | **all 33** | **0.48** | **0.67** | **0.57** |
| 0.4.0, keyword | 26 paraphrase | 0.27 | 0.39 | 0.35 |
| 0.4.0, both | 26 paraphrase | 0.35 | 0.58 | 0.45 |
| 0.4.0, keyword | 6 exact | 1.00 | 1.00 | 1.00 |
| 0.4.0, both | 6 exact | 1.00 | 1.00 | 1.00 |

Most of the change from 0.3.1 to 0.4.0 in keyword search comes from one fix the benchmark found. Day, week and month drafts repeat the text of their sessions, so they ranked above the session that held the detail. In 0.3.1, "Airflow" brought back the day, then the session, then the week, month and year. Search now leaves out drafts no person has edited.

Threshold sweep, both modes, all 33 questions:

| Threshold | hit@1 | hit@5 | MRR |
|---|---|---|---|
| 0.20 | 0.52 | 0.73 | 0.60 |
| 0.25 | 0.48 | 0.67 | 0.57 |
| 0.30 | 0.48 | 0.67 | 0.56 |
| **0.35 (default)** | 0.48 | 0.67 | 0.57 |
| 0.40 | 0.46 | 0.58 | 0.52 |
| 0.45 | 0.42 | 0.52 | 0.48 |

0.20 scores best here, but the fixture has only 26 sessions. On a large atlas a low threshold lets weak matches by meaning into nearly every result list, and the fixture cannot show that cost. The default stays at 0.35 until sweeps from real atlases say otherwise.

Brief: 195 tokens on average. Todos from the last 14 days shown: **0 of 3**.

### The author's atlas

16 scopes and 126 sessions from about four weeks of daily work in Claude Code. No rollups were sealed, so all 200 probes are event probes.

| Mode | hit@1 | hit@5 | MRR | ms |
|---|---|---|---|---|
| keyword | 0.91 | 0.98 | 0.94 | 5 |
| meaning | 0.79 | 0.91 | 0.84 | 3 |
| both (default) | 0.88 | 0.97 | 0.92 | 5 |

As expected for known-item probes, keyword search is near the ceiling, and fusing in matches by meaning costs a little (MRR 0.94 to 0.92). The threshold sweep moves MRR by no more than 0.01 between 0.20 and 0.45.

Brief: 903 tokens on average across 9 scopes with recent work, 1,423 at most, built in 5 ms. Todos from the last 14 days shown: **0 of 4**.

## What the results say so far

1. **Search by meaning helps where it should.** On paraphrased questions, hit@5 rises from 0.39 to 0.58. On exact lookups nothing is lost.
2. **On known-item search it costs a little** (MRR 0.94 to 0.92 on the author's atlas). The paraphrased tier on real atlases will show whether that trade holds when people ask in their own words.
3. **The brief drops open todos.** It shows the open threads of the last session only, so a todo logged three sessions ago disappears. Both datasets score 0%. This is the next thing to fix.
4. **The model is small.** potion-base-8M was chosen because it runs in plain TypeScript with no native code and no download at search time. A larger model would likely do better on paraphrases, and a report comparing models would be welcome.

## Limits of the method

- The fixture's questions were written by the author, who also chose the default threshold after seeing them. Treat fixture numbers as a regression check, and reports from other atlases as the real measure.
- Event probes come from text the agent logged, so they test whether search can find what was written, not whether people ask that way. The paraphrased tier is the correction.
- A probe counts only the notes it was built from as answers. A different note that also answers the question scores as a miss.
