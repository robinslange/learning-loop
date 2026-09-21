// One reader for Claude Code JSONL transcripts. The ledger hook and the usage
// probe both need the same walk; parsing twice per Stop would cost the budget
// twice.

// Known wrapper tags the harness prepends to injected/synthetic content, not
// real user text. A bare '<' prefix used to drop these AND a pasted
// XML/HTML snippet as the first prompt, which then left the ledger's Goal
// section empty for that session.
const WRAPPER_TAGS = [
  '<local-command-caveat>',
  '<command-name>',
  '<system-reminder>',
  '<task-notification>',
  '<local-command-stdout>',
];

export function parseTranscript(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // A live transcript is written asynchronously and can end mid-line.
      // Counted by walkTranscript's caller via records.skipped below.
      out.skipped = (out.skipped || 0) + 1;
    }
  }
  return out;
}

function blocks(rec) {
  const c = rec?.message?.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c : [];
}

function promptText(rec) {
  if (rec.isMeta === true) return null;
  const bs = blocks(rec);
  if (bs.some((b) => b?.type === 'tool_result')) return null;
  const text = bs
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text || WRAPPER_TAGS.some((tag) => text.startsWith(tag))) return null;
  return text;
}

export function walkTranscript(records) {
  const w = {
    prompts: [],
    toolUses: [],
    assistantTexts: [],
    firstTs: null,
    lastTs: null,
    skippedLines: 0,
  };
  if (!Array.isArray(records)) return w;
  w.skippedLines = records.skipped || 0;
  for (const rec of records) {
    const ts = typeof rec?.timestamp === 'string' ? rec.timestamp : null;
    if (ts) {
      if (!w.firstTs || ts < w.firstTs) w.firstTs = ts;
      if (!w.lastTs || ts > w.lastTs) w.lastTs = ts;
    }
    if (rec?.type === 'user') {
      const text = promptText(rec);
      if (text) w.prompts.push({ ts, text });
      continue;
    }
    if (rec?.type !== 'assistant') continue;
    for (const b of blocks(rec)) {
      if (b?.type === 'tool_use') {
        w.toolUses.push({
          ts,
          name: b.name,
          input: b.input || {},
          direct: (b.caller?.type ?? 'direct') === 'direct',
        });
      } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        w.assistantTexts.push({ ts, text: b.text });
      }
    }
  }
  return w;
}
