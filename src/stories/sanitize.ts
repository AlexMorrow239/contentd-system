// Algospeak substitution for story narration.
//
// The scorer's hard-zero rule rejects genuinely unpublishable posts. This
// handles everything below that bar: ordinary conflict that happens to contain
// a word platform moderation penalizes. Substitution rather than an audio
// bleep — it needs no word-timing alignment, so nothing can leak through a
// missed span, and it survives the platform's own transcription of the audio.
//
// Keys are lowercase, single words; the replacer restores the source's
// capitalisation. Expect to curate this over time as platforms shift.

// EVERY entry must be substitutable for its key in ANY sentence the key can
// appear in — same part of speech, same inflection. Narration is verbatim, so
// a mismatch does not degrade a summary, it ships broken English in the video.
//
// Six candidates were deliberately REJECTED for failing that rule; do not
// reinstate them without solving the underlying problem:
//   abuse  -> mistreatment  noun for a verb: "he would abuse me"
//   dead   -> no longer with us  "dead end", "the battery was dead"
//   shot   -> hit           "flu shot", "shot a video", "shot glass"
//   gun    -> pew pew       tonally absurd in a serious story
//   murder -> unalive       'unalive' has no noun form:
//                           "investigated the murder" -> "the unalive"
//   death  -> passing       changes MEANING, not just tone:
//                           "death threats" -> "passing threats"
// 'shot' in particular cannot be fixed by a word map at all — it needs to know
// whether the sentence means a firearm, and this module is a word map.
//
// 'died -> passed' is KEPT despite a known wrinkle: "died of cancer" becomes
// "passed of cancer", which is non-idiomatic but not wrong. That is a
// preposition, not a meaning change, and 'died' is how these stories usually
// refer to a death.
//
// KNOWN, ACCEPTED LEAKS. A word map cannot see collocation, and these were
// judged too infrequent in this genre to be worth further guards. Real
// published output will surface the rest faster than review does:
//   "make a killing"        -> "make an unaliving"   (financial sense)
//   "the sex of the baby"   -> "the seggs of..."     (category sense)
//   "went in for the kill"  -> "...for the unalive"  (noun sense)
//   "he drugs her drink"    -> "he substances..."    (verb sense)
export const ALGOSPEAK: Record<string, string> = {
  kill: 'unalive',
  kills: 'unalives',
  killed: 'unalived',
  killing: 'unaliving',
  murdered: 'unalived',
  suicide: 'self-deletion',
  rape: 'SA',
  raped: 'SA-ed',
  rapist: 'SA-er',
  died: 'passed',
  sex: 'seggs',
  sexual: 'seggsual',
  porn: 'adult content',
  drugs: 'substances',
  abused: 'mistreated',
}

// One alternation over every key, longest first so 'killed' cannot be matched
// as 'kill' + 'ed'. \b on both sides is what keeps 'skilled' intact.
// 'died' has a negative lookahead to exclude particle forms that change meaning:
// "died down/out/off/away" have senses distinct from the base verb.
const keys = Object.keys(ALGOSPEAK).sort((a, b) => b.length - a.length)
const terms = keys.map(k => k === 'died' ? 'died(?!\\s+(?:down|out|off|away)\\b)' : k).join('|')
const PATTERN = new RegExp(`\\b(${terms})\\b`, 'gi')

/**
 * Match the source's capitalisation: an initial capital is carried onto the
 * replacement, anything else (including ALL CAPS) renders as written in the
 * map with only the first letter matched — shouting the euphemism reads worse
 * than the original did.
 */
function matchCase(source: string, replacement: string): string {
  const capitalized = source[0] === source[0].toUpperCase()
  if (!capitalized) return replacement
  return replacement[0].toUpperCase() + replacement.slice(1)
}

export function sanitizeStory(text: string): string {
  return text.replace(PATTERN, (match) => matchCase(match, ALGOSPEAK[match.toLowerCase()]))
}
