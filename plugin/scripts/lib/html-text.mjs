// scripts/lib/html-text.mjs : the shared markup-to-text reduction for fetched sources.
// One definition so web-fetch (whole pages) and the abstract readers (crossref, pubmed,
// check-claims) cannot drift. Everything here reduces attacker-authored markup to text
// that is then handed to a model, so each step is ordered against a specific bypass:
//
//   - script/style bodies are dropped BEFORE tag stripping, and a body with no closing
//     tag runs to end-of-input. Otherwise `<script>var x=1` loses only its opening tag
//     and the script source survives as prose.
//   - a tag with no closing `>` runs to the end of the input and is dropped with it.
//     A single `<[^>]+>` replace needs the `>`, which is how `<div class="x` survived.
//   - entities decode in ONE pass over the string. Decoding `&amp;` and then `&lt;` in
//     separate passes re-reads its own output, so `&amp;lt;` became `<` and rebuilt the
//     markup that tag stripping had just removed.
//
// Decoding runs after stripping, which is deliberate: a page that escapes `&lt;script&gt;`
// is displaying that text, so one decode is the faithful reading of what it shows.

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const RAW_TEXT_ELEMENT = /<(script|style)\b[\s\S]*?(?:<\/\1[^>]*>|$)/gi;
const TAG_START = /<[a-z!/]/i;
const ENTITY = new RegExp(`&(${Object.keys(ENTITIES).join('|')});`, 'gi');

/**
 * Strip markup tags, including a trailing tag that is never closed.
 *
 * A scan rather than a replace. Copying the text between tags means the output is built
 * from spans that were never markup, so there is no pass over a partly-stripped string
 * for a `<` and a `>` to find each other across -- the class of bug a strip-and-rescan
 * has to loop to defend against.
 *
 * Once no `>` remains there can be no further complete tag, so the rest is text up to the
 * first `<` that opens one, and everything from there is dropped as a tag that ran off the
 * end of the input. That keeps "if a < b" whole while still dropping a trailing `<script`.
 */
export function stripTags(markup) {
  if (typeof markup !== 'string') return '';
  let out = '';
  let i = 0;
  for (;;) {
    const lt = markup.indexOf('<', i);
    if (lt === -1) return out + markup.slice(i);
    out += markup.slice(i, lt);
    const gt = markup.indexOf('>', lt);
    if (gt === -1) {
      const rest = markup.slice(lt);
      const opens = rest.search(TAG_START);
      return opens === -1 ? out + rest : out + rest.slice(0, opens);
    }
    i = gt + 1;
  }
}

/** Decode the named entities we emit, in a single pass so no output is re-read. */
export function decodeEntities(text) {
  if (typeof text !== 'string') return '';
  return text.replace(ENTITY, (_, name) => ENTITIES[name.toLowerCase()]);
}

/** Reduce a full HTML document to collapsed plain text. */
export function htmlToText(html) {
  if (typeof html !== 'string') return '';
  const stripped = stripTags(html.replace(RAW_TEXT_ELEMENT, ' '));
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}
