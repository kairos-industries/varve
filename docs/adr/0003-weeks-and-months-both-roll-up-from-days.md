# Weeks and months both roll up from days

ISO weeks cross month boundaries, so a month cannot be built from whole week notes. Week and month notes are therefore both summarized from sealed day notes, and only the year is summarized from the layer directly below it (months). A month rollup reads up to about 31 day notes, roughly 12k tokens for a typical month, which fits under the default cost gate.

## Considered options

- Month from overlapping weeks, clipped to the month: the edge weeks mix in another month's work and the clipping is unreliable.
- Calendar weeks clipped at month ends: weeks would no longer be seven days and would disagree with ISO week numbers.
