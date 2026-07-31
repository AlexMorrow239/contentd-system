// Shapes taken verbatim from live reddit feeds captured 2026-07-30 (raw
// captures under superpowers/fixtures-source/). These are POST-fast-xml-parser
// strings: the XML-level entity decode has already happened, so `&#39;` here
// is what storyBody actually receives on the wire.

/**
 * A self post: SC_OFF span present, two paragraphs, an escaped apostrophe.
 * Deliberately 49 words — comfortably over STORY_MIN_BODY_WORDS, so it
 * exercises the default floor rather than needing tests to disable it.
 */
export const SELF_POST_CONTENT =
  '<!-- SC_OFF --><div class="md"><p>One month ago I hosted a movie night for my five ' +
  'closest friends. It&#39;s a long story but I need to know if I was wrong here.</p> ' +
  '<p>Before the movie a friend called me and asked if she could bring some fruit to ' +
  'blend into a drink for everyone.</p> ' +
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
