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
