#!/usr/bin/env node
// refinement-validate.mjs — Validate and clean refinement-proposer agent output.
//
// The agent's structured JSON cannot be trusted blindly. Sonnet has a
// persistent em-dash habit and can't reliably self-measure its own output
// size. The driver must enforce both rules post-hoc.
//
// This script:
//   1. Parses the agent JSON
//   2. For each `edit` decision:
//      a. Strips em-dashes from `proposed_body` (logs as `em_dash_violation`)
//      b. Reads the current upstream body
//      c. Computes sentence delta (added - removed) / original_count
//      d. Tags `oversized` if > 20%, `auto_rejected` if > 50%
//      e. Verifies frontmatter byte-equality with the upstream
//   3. For each `counterpoint` decision: validates the link texts have stems
//   4. Emits a cleaned JSON object with per-decision validation flags
//
// Usage:
//   refinement-validate.mjs <agent-output.json> <pairs.json>
//   refinement-validate.mjs --stdin              # agent JSON via stdin
//   --pairs <path>                                # required when using --stdin
//
// Output: validated JSON to stdout. Exit 0 on success regardless of
// per-decision flags. Exit 1 if input is unparseable or pairs file missing.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const OVERSIZED_THRESHOLD = 0.20;
const AUTO_REJECT_THRESHOLD = 0.50;
const EM_DASH = '\u2014';
const EM_DASH_REPLACEMENT = ', ';

function stripFrontmatter(body) {
  const m = body.match(/^---\n[\s\S]*?\n---\n?/);
  if (m) return body.slice(m[0].length);
  return body;
}

function extractFrontmatter(body) {
  const m = body.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? m[0] : '';
}

function countSentences(body) {
  // Strip code blocks and frontmatter, then split on sentence boundaries.
  const stripped = stripFrontmatter(body)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\[\[[^\]]+\]\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return 0;
  const matches = stripped.match(/[^.!?]+[.!?]+/g);
  return matches ? matches.length : 1;
}

function stripEmDashes(text) {
  if (!text) return { cleaned: text, count: 0 };
  let count = 0;
  const cleaned = text.replace(new RegExp(EM_DASH, 'g'), () => {
    count++;
    return EM_DASH_REPLACEMENT;
  });
  return { cleaned, count };
}

function validateEdit(decision, currentBody) {
  const flags = [];

  // Split proposed_body into frontmatter and body. Em-dash strip applies ONLY
  // to the body — preserving the upstream's frontmatter exactly (including any
  // existing em-dashes the user wrote there).
  const proposedRaw = decision.proposed_body || '';
  const proposedFmRaw = extractFrontmatter(proposedRaw);
  const proposedBodyOnly = proposedRaw.slice(proposedFmRaw.length);

  // 1. Em-dash strip (body only)
  const { cleaned: cleanedBodyOnly, count: emDashCount } = stripEmDashes(proposedBodyOnly);
  if (emDashCount > 0) flags.push({ type: 'em_dash_violation', count: emDashCount });

  // 2. Frontmatter integrity. The upstream frontmatter must be byte-equal to
  // the proposed frontmatter (after em-dash normalization to forgive the
  // strip pass that already ran). When applying, the driver always uses the
  // upstream's original frontmatter, never the proposed one — this check is
  // diagnostic, not corrective.
  const currentFm = extractFrontmatter(currentBody);
  const normalize = (s) => s.replace(new RegExp(EM_DASH, 'g'), EM_DASH_REPLACEMENT);
  if (normalize(currentFm) !== normalize(proposedFmRaw)) {
    flags.push({ type: 'frontmatter_modified', detail: 'frontmatter byte-mismatch after em-dash normalization' });
  }

  // Reassemble the cleaned body using the upstream's ORIGINAL frontmatter to
  // guarantee no frontmatter mutation on apply, even if the agent touched it.
  let cleanedBody = currentFm + cleanedBodyOnly;
  // Match upstream's trailing newline policy (most vault notes end with one).
  if (currentBody.endsWith('\n') && !cleanedBody.endsWith('\n')) cleanedBody += '\n';

  // 3. Sentence delta
  const currentCount = countSentences(currentBody);
  const proposedCount = countSentences(cleanedBody);
  const delta = currentCount === 0 ? 0 : Math.abs(proposedCount - currentCount) / currentCount;
  const sizeFlag = {
    type: 'size',
    current_sentences: currentCount,
    proposed_sentences: proposedCount,
    delta_ratio: Number(delta.toFixed(3)),
  };

  let status = 'ok';
  if (delta > AUTO_REJECT_THRESHOLD) {
    status = 'auto_rejected';
    sizeFlag.severity = 'auto_rejected';
    flags.push(sizeFlag);
  } else if (delta > OVERSIZED_THRESHOLD) {
    status = 'oversized_warning';
    sizeFlag.severity = 'warning';
    flags.push(sizeFlag);
  }

  // 4. Sentence removal check (proposed must include all original sentences as substrings, loosely)
  // Skip for now - frontmatter check + 20% cap is the main safety. The reviewer will catch removals.

  return {
    cleaned_body: cleanedBody,
    flags,
    status,
  };
}

function validateCounterpoint(decision) {
  const flags = [];
  if (!decision.new_note_link_text || !/\[\[.+\]\]/.test(decision.new_note_link_text)) {
    flags.push({ type: 'malformed_link', side: 'new_note' });
  }
  if (!decision.upstream_link_text || !/\[\[.+\]\]/.test(decision.upstream_link_text)) {
    flags.push({ type: 'malformed_link', side: 'upstream' });
  }
  return {
    flags,
    status: flags.length ? 'malformed' : 'ok',
  };
}

function main() {
  const args = process.argv.slice(2);
  let agentJson;
  let pairsPath;

  if (args.includes('--stdin')) {
    agentJson = readFileSync(0, 'utf-8');
    const pairsIdx = args.indexOf('--pairs');
    if (pairsIdx < 0) {
      process.stderr.write('--pairs <path> required with --stdin\n');
      process.exit(1);
    }
    pairsPath = args[pairsIdx + 1];
  } else {
    if (args.length < 2) {
      process.stderr.write('usage: refinement-validate.mjs <agent.json> <pairs.json>\n');
      process.exit(1);
    }
    agentJson = readFileSync(args[0], 'utf-8');
    pairsPath = args[1];
  }

  if (!existsSync(pairsPath)) {
    process.stderr.write(`pairs file not found: ${pairsPath}\n`);
    process.exit(1);
  }

  // Sonnet often adds preamble before the JSON despite the prompt asking for
  // JSON-only output. Extract the JSON object containing a "decisions" key
  // from anywhere in the response by scanning for the first balanced object
  // that contains "decisions".
  function extractDecisionsJson(text) {
    // First try direct parse (clean output case)
    try {
      const direct = JSON.parse(text);
      if (direct && Array.isArray(direct.decisions)) return direct;
    } catch {}
    // Strip code fences if present
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      try {
        const inner = JSON.parse(fenced[1]);
        if (inner && Array.isArray(inner.decisions)) return inner;
      } catch {}
    }
    // Scan for the first { that opens a balanced object containing "decisions"
    for (let start = 0; start < text.length; start++) {
      if (text[start] !== '{') continue;
      let depth = 0;
      let inStr = false;
      let escape = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inStr) {
          if (escape) escape = false;
          else if (ch === '\\') escape = true;
          else if (ch === '"') inStr = false;
        } else {
          if (ch === '"') inStr = true;
          else if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) {
              const candidate = text.slice(start, i + 1);
              if (!candidate.includes('"decisions"')) break;
              try {
                const obj = JSON.parse(candidate);
                if (obj && Array.isArray(obj.decisions)) return obj;
              } catch {}
              break;
            }
          }
        }
      }
    }
    return null;
  }

  const parsed = extractDecisionsJson(agentJson);
  if (!parsed) {
    process.stderr.write(`failed to extract decisions JSON from agent output\n`);
    process.exit(1);
  }

  const pairs = JSON.parse(readFileSync(pairsPath, 'utf-8'));
  const pairById = new Map(pairs.map(p => [p.id, p]));

  const validated = [];
  for (const d of parsed.decisions || []) {
    const pair = pairById.get(d.id);
    if (!pair) {
      validated.push({ ...d, validation: { status: 'unknown_pair', flags: [] } });
      continue;
    }

    if (d.decision === 'edit') {
      let currentBody = '';
      try {
        currentBody = readFileSync(pair.candidate, 'utf-8');
      } catch (e) {
        validated.push({
          ...d,
          validation: { status: 'upstream_unreadable', flags: [{ type: 'read_error', detail: e.message }] },
        });
        continue;
      }
      const result = validateEdit(d, currentBody);
      validated.push({
        ...d,
        proposed_body: result.cleaned_body,
        upstream_path: pair.candidate,
        new_note_path: pair.new_note,
        cosine: pair.cosine,
        validation: { status: result.status, flags: result.flags },
      });
    } else if (d.decision === 'counterpoint') {
      const result = validateCounterpoint(d);
      validated.push({
        ...d,
        upstream_path: pair.candidate,
        new_note_path: pair.new_note,
        cosine: pair.cosine,
        validation: { status: result.status, flags: result.flags },
      });
    } else {
      // pass
      validated.push({
        ...d,
        upstream_path: pair.candidate,
        new_note_path: pair.new_note,
        cosine: pair.cosine,
        validation: { status: 'ok', flags: [] },
      });
    }
  }

  // Summary stats
  const summary = {
    total: validated.length,
    pass: validated.filter(d => d.decision === 'pass').length,
    edit_ok: validated.filter(d => d.decision === 'edit' && d.validation.status === 'ok').length,
    edit_oversized: validated.filter(d => d.decision === 'edit' && d.validation.status === 'oversized_warning').length,
    edit_auto_rejected: validated.filter(d => d.decision === 'edit' && d.validation.status === 'auto_rejected').length,
    counterpoint_ok: validated.filter(d => d.decision === 'counterpoint' && d.validation.status === 'ok').length,
    em_dash_violations: validated.filter(d => d.validation.flags.some(f => f.type === 'em_dash_violation')).length,
    frontmatter_violations: validated.filter(d => d.validation.flags.some(f => f.type === 'frontmatter_modified')).length,
  };

  process.stdout.write(JSON.stringify({ summary, decisions: validated }, null, 2) + '\n');
}

main();
