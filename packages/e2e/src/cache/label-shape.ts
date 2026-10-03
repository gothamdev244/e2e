/**
 * Label shapes: a control's label with the state it carries taken out.
 *
 * Many apps put state in a control's label: `Like (0 likes)`, `Reply (1
 * reply)`, a row named after its author and `· now`. A recording made at one
 * count never re-finds the control at the next, so the last rung of the
 * relocation ladder (`relocate.ts`) compares labels by shape. The fold is
 * deliberately narrow: only a count governing a noun and a relative time or
 * age. A number that names rather than counts, `Delete item 3`, `Page 2`,
 * `Order #1234`, `Count: 1`, stays as it reads, so two such labels are two
 * controls and the ladder never moves an action onto the neighbour.
 */

/**
 * A relative time word: the part of a label a calendar moves. `now` counts
 * only as a time of its own, at an edge of the label or beside a separator
 * (`Bob · now`), never as the adverb of `Buy now`.
 */
const RELATIVE_TIME = /\bjust\s+now\b|(?<=^|[^\w\s]\s*)now(?=\s*(?:$|[^\w\s]))|\b(?:today|yesterday|tomorrow)\b/gi;

/**
 * A count with a unit of time, `2m`, `3 days`: the part of a label a clock
 * moves. A spelled unit is read in any case; a one-letter unit is lower
 * case only, since `3 M` is a size, not minutes.
 */
export const AGE_PATTERNS: readonly RegExp[] = [
  /\b\d+\s*(?:secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|weeks?|months?|years?)\b/i,
  /\b\d+\s*(?:ms|[smhdwy]|mo)\b/,
];
const AGES = AGE_PATTERNS.map((pattern) => new RegExp(pattern.source, `${pattern.flags}g`));

/**
 * A count at the start of a label or right after a separator or an opening
 * bracket (`3 followers`, `Like (0 likes)`, `Bob · 2 replies`), with the word
 * after it. A number after a word names what it follows (`Team 3 members`,
 * `Open item 3 menu`) and is never a tally.
 */
const LEADING_COUNT = /(^|[([·•|,:;/\u2013\u2014-]\s*)(\d+)(\s+)([a-z]{3,})\b/g;

/** The placeholder a relative time or an age reads as. */
const AGE_MARK = '<age>';

/**
 * A label with its tallies and times taken out. A relative time or an age
 * reads `<age>`; a tally reads `#` and its noun is reduced to a stem its
 * singular and plural share (`reply`/`replies`, `match`/`matches`), so
 * `Reply (0 replies)` and `Reply (1 reply)` are one shape. A tally is a
 * leading count (`LEADING_COUNT`) that agrees with its noun: one with any
 * noun, any other count with a plural, so `3 menu` reads as it is. Case and whitespace are folded too.
 */
function labelShape(label: string): string {
  // Times fold before the case does: `3 M` is a size, `3 m` an age.
  const timed = AGES.reduce((text, age) => text.replace(age, AGE_MARK), label.replace(RELATIVE_TIME, AGE_MARK)).toLowerCase();
  const counted = timed.replace(LEADING_COUNT, (match, lead: string, count: string, space: string, noun: string) =>
    count === '1' || noun.endsWith('s') ? `${lead}#${space}${countedStem(noun)}` : match,
  );
  return counted.replace(/\s+/g, ' ').trim();
}

/**
 * The stem a counted noun shares with its plural: an `-es` after a sibilant
 * dropped (`matches`, `boxes`), else a trailing `s`, then `ie` and `y`
 * endings folded to `i`.
 */
function countedStem(noun: string): string {
  const singular = /(?:[sxz]|[cs]h)es$/.test(noun)
    ? noun.slice(0, -2)
    : noun.length > 3 && noun.endsWith('s') && !noun.endsWith('ss')
      ? noun.slice(0, -1)
      : noun;
  return singular.replace(/(?:ie|y)$/, 'i');
}

/** Whether a label carries a tally or a time the shape reads as a placeholder. */
export function carriesState(label: string): boolean {
  return labelShape(label) !== label.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Whether two labels share a shape that still says something. A label that
 * is nothing but a time (`now`, `2m`) has a shape that says only that it is a
 * time, so it is compared as it reads: a stamp left at `now` is not the
 * recorded `2m`.
 */
export function sameLabelShape(recorded: string, candidate: string): boolean {
  const shape = labelShape(recorded);
  return shape === AGE_MARK ? recorded.trim() === candidate.trim() : shape === labelShape(candidate);
}
