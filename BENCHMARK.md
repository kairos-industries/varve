# Benchmark

`temporal-atlas bench` measures how well Temporal Atlas brings back past work: whether search finds the note that answers a question, and whether the brief shows what is still open. It calls no model and only reads the atlas.

The numbers below are the baseline. Each report sent in adds a real atlas, and the defaults (search threshold, what goes in the brief) will be chosen from those reports.

## Run it

```sh
temporal-atlas models pull          # once, so search by meaning is scored too
temporal-atlas bench --fixture      # the bundled atlas: the same on every machine
temporal-atlas bench --sweep        # your own atlas, with the similarity threshold sweep
```

`bench` on your own atlas saves its report to `.atlas/bench/bench-<date>.json` in the atlas folder. The report holds numbers only: the version, platform, Node version, model id, counts of scopes, sessions and notes, and the scores. It never contains note text, project names or note names, and a test fails if it ever does (`test/bench.test.ts`).

## Send your results

Open an issue with the **Benchmark result** template and paste the JSON. Add a sentence on how you use the atlas (Claude Code or Codex, nightly or agent rollups, how many weeks), since the numbers depend on it.

## What it measures

**Search.** Each probe is a query plus the notes that answer it. It is searched three ways (keyword only, meaning only, both fused) and scored:

| Score | Meaning |
|---|---|
| hit@1 | The first result answers the query |
| hit@5 | An answer is in the first five results |
| MRR | Mean of 1 / rank of the first answer within the first ten, 0 if none |
| ms | Median time per search |

Every score comes with a 95% bootstrap interval (2,000 resamples, fixed seed, so the interval is the same on every run). Hybrid search is also compared with keyword search probe by probe: the mean MRR difference, its 95% paired bootstrap interval, and how many probes got better or worse.

**Brief.** For each scope with work in the last 14 days: the brief's size in tokens, the time to build it, and the share of todos logged in those 14 days that the brief shows.

**Sweep** (`--sweep`). Hybrid search at similarity thresholds from 0.20 to 0.45. Below the threshold, a note doesn't count as a match by meaning.

## Datasets

**Fixture** (`--fixture`). An invented atlas: 26 sessions over four weeks in three projects (billing API, mobile app, data platform). Session ids are fixed, so every machine builds the same notes. It has 69 questions in two splits:

| Split | Questions | Use |
|---|---|---|
| dev | 33 (26 paraphrase, 6 exact, 1 dated) | Seen while the search defaults were chosen |
| test | 36 (26 paraphrase, 6 exact, 4 dated) | Written afterwards, never used to tune anything |

- **paraphrase** questions are worded the way a colleague would ask weeks later ("the spreadsheet download we got rid of" for the CSV export removal).
- **exact** questions look up a name or term (`VIES`, `LaunchDarkly`, `guideline 5.1.1`).
- **dated** questions are vague queries with a date range.

The dev paraphrases avoid every distinctive word of their target note. The test paraphrases were written later and less strictly, and share more words with their notes: keyword search finds 81% of them in the top five, against 39% of the dev ones. Both splits are in [src/bench/fixture.ts](src/bench/fixture.ts).

**Your atlas.** Probes come from what is already there:

- **event**: a logged decision, finding or change, cut to its first clause (at most eight words), to find the session that logged it. It is searched within its own scope, as an agent working there would. The query's words are in the target note, so this is known-item search, and it flatters keyword search.
- **summary**: a sealed day or week headline, to find the notes it was written from. The headline is new wording. These appear once rollups are sealed.

At most 200 probes are used (`--max`), sampled across the whole atlas.

**Paraphrased** (`--paraphrase`, optional, paid). A model rewords your atlas's queries the way a colleague would ask from memory, and the rewordings are scored. This removes the word-overlap advantage of event probes. Only the queries are sent, through your own `claude` CLI. It shows the estimate, asks first, and stops at `--max-usd` (default $0.25, model `haiku`).

## Results

The reports behind these tables are in [docs/benchmark/](docs/benchmark/). The README figures are drawn from them by `npm run charts`.

### Fixture

Search model potion-base-8M at revision `bf8b056`, macOS, Node 24. "0.3.1" is 0.4.0's code with drafts searched and no search model, which is how 0.3.1 searched (0.3.1 has no `bench` command).

Mean reciprocal rank, with 95% intervals:

| Version, mode | All 69 | dev (33) | test, held out (36) |
|---|---|---|---|
| 0.3.1, keyword | 0.47 (0.36 to 0.56) | 0.34 (0.22 to 0.48) | 0.58 (0.44 to 0.72) |
| 0.4.0, keyword only | 0.55 (0.44 to 0.65) | 0.48 (0.33 to 0.64) | 0.61 (0.48 to 0.75) |
| 0.4.0, meaning only | 0.44 (0.35 to 0.56) | 0.46 (0.30 to 0.62) | 0.43 (0.28 to 0.60) |
| **0.4.0, keyword + meaning (default)** | **0.64 (0.54 to 0.74)** | **0.57 (0.42 to 0.71)** | **0.71 (0.59 to 0.84)** |

Hybrid against keyword, probe by probe:

| Questions | MRR difference (95% interval) | Better | Worse |
|---|---|---|---|
| All 69 | +0.09 (0.03 to 0.17) | 12 | 5 |
| dev | +0.08 (-0.01 to 0.17) | 6 | 2 |
| test, held out | +0.10 (0.01 to 0.22) | 6 | 3 |

By kind of question, all 69, 0.3.1 against the 0.4.0 default:

| Kind | Questions | hit@5, 0.3.1 | hit@5, 0.4.0 | MRR, 0.3.1 | MRR, 0.4.0 |
|---|---|---|---|---|---|
| paraphrase | 52 | 0.54 | 0.71 | 0.41 | 0.58 |
| exact | 12 | 1.00 | 1.00 | 0.84 | 1.00 |
| dated | 5 | 0.20 | 0.60 | 0.14 | 0.47 |

Most of the gain in keyword search from 0.3.1 to 0.4.0 comes from one fix the benchmark found. Day, week and month drafts repeat the text of their sessions, so they ranked above the session that held the detail: in 0.3.1, "Airflow" returned the day draft first, then the session, then the week, month and year. Search now leaves out drafts no person has edited.

Threshold sweep, hybrid, all 69 questions:

| Threshold | hit@1 | hit@5 | MRR |
|---|---|---|---|
| 0.20 | 0.56 | 0.83 | 0.68 |
| 0.25 | 0.54 | 0.75 | 0.64 |
| 0.30 | 0.56 | 0.75 | 0.64 |
| **0.35 (default)** | 0.55 | 0.75 | 0.64 |
| 0.40 | 0.51 | 0.70 | 0.59 |
| 0.45 | 0.48 | 0.67 | 0.56 |

0.20 scores best here, but the fixture has only 26 sessions. On a large atlas a low threshold lets weak matches by meaning into nearly every result list, a cost the fixture can't show. The default stays at 0.35 until sweeps from real atlases say otherwise.

Brief: 195 tokens on average. Todos from the last 14 days shown: **0 of 3**.

### The author's atlas

16 scopes and 126 sessions from about four weeks of daily work in Claude Code. No rollups were sealed, so all 200 probes are event probes.

| Mode | hit@1 | hit@5 | MRR (95% interval) | ms |
|---|---|---|---|---|
| keyword | 0.91 | 0.98 | 0.94 (0.92 to 0.97) | 6 |
| meaning | 0.79 | 0.91 | 0.84 (0.80 to 0.89) | 6 |
| keyword + meaning (default) | 0.87 | 0.97 | 0.92 (0.88 to 0.95) | 6 |

As expected for known-item probes, keyword search is near the ceiling, and fusing in matches by meaning costs a little. The threshold sweep moves MRR by no more than 0.01 between 0.20 and 0.45.

Brief: 901 tokens on average across 9 scopes with recent work, 1,423 at most, built in 5 ms. Todos from the last 14 days shown: **0 of 4**.

## What the results say so far

**A worked example.** "Typefaces slowing down the first launch" (held-out) shares no distinctive word with its note, "Cold start was 3.1 s on a Pixel 6; 1.2 s of it went to loading every font family." Keyword search doesn't return it in the first ten; hybrid ranks it first. Single words carry too little meaning for this model: "login" scores 0.16 against a note about Okta SSO, below the 0.35 threshold, so it still needs the keyword.

1. **Fusing meaning with keyword search helps where people paraphrase**, and the gain holds on the held-out questions (+0.10 MRR, interval 0.01 to 0.22). The intervals are wide because the fixture is small.
2. **Meaning alone is worse than keyword alone** on every split, so it is only used fused.
3. **On known-item search, fusing costs a little** (0.94 to 0.92 on the author's atlas). The paraphrased tier on real atlases will show whether the trade holds when people ask in their own words.
4. **The brief drops open todos.** It shows the open threads of the last session only, so a todo logged three sessions ago disappears. Both datasets score 0%. This is the next thing to fix.
5. **The model is small.** potion-base-8M runs in plain TypeScript with no native code and no download at search time. A larger model would likely do better on paraphrases, and a report comparing models is welcome.

## Limits of the method

- The author wrote every fixture question and chose the default threshold after seeing the dev split. The test split is held out from tuning but not from the author. Treat the fixture as a regression check and reports from other atlases as the real measure.
- Event probes come from text the agent logged, so they test whether search finds what was written, not whether people ask that way. The paraphrased tier corrects for this.
- A probe counts only the notes it was built from as answers. Another note that also answers the question scores as a miss.
- 69 questions give intervals about ±0.10 wide. A difference smaller than that is noise.
