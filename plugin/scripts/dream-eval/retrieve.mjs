export function buildPickPrompt(question, indexText) {
  return [
    `Given this question: ${question}`,
    `and this MEMORY.md index:`,
    indexText,
    `Which up to 3 memory files would you Read to answer? Return JSON only: {"paths": [...]}.`,
  ].join('\n\n');
}

function parsePaths(reply) {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : reply;
  try {
    const obj = JSON.parse(body.trim());
    return Array.isArray(obj.paths) ? obj.paths.filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

export async function retrieve({ question, indexText, pick }) {
  const reply = await pick(buildPickPrompt(question, indexText));
  return parsePaths(reply);
}

// A split-index pointer, not a memory file: MEMORY.md lists these instead of
// the individual Feedback/Project/Reference notes (2026-07-13 size-cap rebuild).
export function isIndexFile(path) {
  return /^_index_[a-z]+\.md$/.test(path);
}

// The live lookup for a split index is two hops: the assistant LLM-picks from
// MEMORY.md, and when that lands on an `_index_*.md` pointer it reads that
// index and LLM-picks the target file from ITS entries. The harness must run
// the same two hops or it measures a system that does not exist. A hop-1 pick
// that is already a real memory file (User-tier, listed directly in MEMORY.md)
// needs no second hop and passes through unchanged.
//
// readIndexFile(indexPath) -> string[] of the memory filenames that index
// lists; injected so the module never touches the real filesystem.
export async function retrieveTwoHop({ question, indexText, pick, readIndexFile }) {
  const firstHop = await retrieve({ question, indexText, pick });
  const resolved = [];
  for (const path of firstHop) {
    if (!isIndexFile(path)) {
      resolved.push(path);
      continue;
    }
    let entries;
    try {
      entries = readIndexFile(path);
    } catch {
      continue; // unreadable index: drop it, do not fail the probe
    }
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const entryIndex = entries.map((f) => `- ${f}`).join('\n');
    const secondReply = await pick(buildPickPrompt(question, entryIndex));
    for (const target of parsePaths(secondReply)) resolved.push(target);
  }
  return resolved;
}
