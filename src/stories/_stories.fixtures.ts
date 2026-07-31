// Shapes taken verbatim from live reddit feeds captured 2026-07-30 (raw
// captures under superpowers/fixtures-source/). These are POST-fast-xml-parser
// strings: the XML-level entity decode has already happened, so `&#39;` here
// is what storyBody actually receives on the wire.

/**
 * A self post: SC_OFF span present, two paragraphs, an escaped apostrophe.
 * Deliberately 50 words — comfortably over STORY_MIN_BODY_WORDS, so it
 * exercises the default floor rather than needing tests to disable it.
 */
export const SELF_POST_CONTENT =
  '<!-- SC_OFF --><div class="md"><p>One month ago I hosted a movie night for my five ' +
  'closest friends. It&#39;s a long story but I need to know if I was wrong here.</p> ' +
  '<p>Before the movie a friend called me and asked if she could bring some fruit to ' +
  'blend into a drink for everyone today.</p> ' +
  '</div><!-- SC_ON --> &#32; submitted by &#32; ' +
  '<a href="https://www.reddit.com/user/BrazilLost_1-2"> /u/BrazilLost_1-2 </a> ' +
  '<a href="https://www.reddit.com/r/AmItheAsshole/comments/abc123/">[link]</a> ' +
  '<a href="https://www.reddit.com/r/AmItheAsshole/comments/abc123/">[comments]</a>'

/** A link post (r/AskReddit shape): no SC_OFF span, anchors only. */
export const LINK_POST_CONTENT =
  '<a href="https://www.reddit.com/user/someone"> /u/someone </a> ' +
  '<a href="https://www.reddit.com/r/AskReddit/comments/xyz789/">[link]</a> ' +
  '<a href="https://www.reddit.com/r/AskReddit/comments/xyz789/">[comments]</a>'

/** An author who wrote a literal less-than sign: must survive intact. */
export const LITERAL_ENTITY_CONTENT =
  '<!-- SC_OFF --><div class="md"><p>She said &lt;3 and I said &amp; what.</p>' +
  '</div><!-- SC_ON --> &#32; submitted by &#32; <a href="#">[comments]</a>'

/** Under STORY_MIN_BODY_WORDS: a real self post that is only a few words. */
export const TINY_BODY_CONTENT =
  '<!-- SC_OFF --><div class="md"><p>Am I wrong here?</p></div><!-- SC_ON -->'

/**
 * An author who wrote the literal text "&lt;" — i.e. the wire carried
 * "&amp;amp;lt;" and fast-xml-parser already unwrapped one layer. Decoding
 * once yields the visible text "&lt;"; decoding twice yields "<", which is
 * live markup. This is the ONLY fixture where correct and buggy behavior
 * differ, so it is what pins decodeEntities to a single pass.
 */
export const NESTED_ENTITY_CONTENT =
  '<!-- SC_OFF --><div class="md"><p>Type &amp;lt;br&amp;gt; to break a line.</p>' +
  '</div><!-- SC_ON -->'

/**
 * A hand-authored, checked-in ~300-word, 5-paragraph story body, in the plain
 * (already-decoded, already-boilerplate-stripped) shape `storyBody` returns.
 *
 * Every other body in this file is <= 50 words — comfortably over
 * STORY_MIN_BODY_WORDS, but nowhere near production's STORY_WORDS_PER_PART
 * (160), so no checked-in test ever exercised splitStory's packing,
 * paragraph-preference, or tail-merge logic against a realistic length. The
 * real 122-story corpus that surfaced the tail-merge blocker
 * (superpowers/fixtures-source/*.rss) is gitignored, so this is deliberately
 * the one committed body long enough to reach that code path in CI.
 *
 * At STORY_WORDS_PER_PART splitStory packs this into two parts (128 and 157
 * words) with a 15-word remainder; without the tail-merge fix that remainder
 * would ship as its own sub-STORY_MIN_TAIL_WORDS runt part 3 — exactly the
 * failure mode measured on 19% of the real corpus.
 */
export const REALISTIC_STORY_BODY =
  'My sister asked me to co-sign her apartment lease last spring, and I said yes because ' +
  'she had just landed a new job and the landlord wanted a guarantor. I did not think ' +
  'much of it at the time. We have always been close, and she has never once missed a ' +
  'payment on anything in her life, so it felt like a formality more than a risk. My ' +
  'parents even told me it was a nice thing to do for family.\n\n' +
  'Three months later she lost that job when the company did a round of layoffs, and she ' +
  'stopped answering my calls for almost two weeks. I found out from our mother that she ' +
  'had also stopped paying rent, and the property manager had already sent two notices. ' +
  'Because my name was on the lease as a guarantor, the agency started calling me directly, ' +
  'and one of the calls came while I was in a meeting at work, which was mortifying.\n\n' +
  'I drove to her apartment and we had a long talk. She admitted she had been too ' +
  'embarrassed to tell anyone and had been quietly job hunting instead of dealing with the ' +
  'lease. I told her I could not keep absorbing calls from the rental agency and that we ' +
  'needed a real plan, not more silence. She got upset and said I was treating her like a ' +
  'child instead of a sister who was struggling.\n\n' +
  'I ended up paying the overdue balance myself to stop the agency from starting an ' +
  'eviction process, since that would have hit my credit too as the guarantor. My sister ' +
  'has since found a new job and is slowly paying me back, but things still feel tense ' +
  'between us.\n\n' +
  'So, am I the jerk here for pushing the issue when she was already struggling?'
