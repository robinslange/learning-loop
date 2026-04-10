#!/usr/bin/env node
// Content reviewed per Task 10 of 2026-04-07-hook-injection-channels-phase-1 — kept as-is
// Learning Loop — PreCompact hook
// Nudges capture before context compression.

const output = {
  hookSpecificOutput: {
    hookEventName: 'PreCompact',
    additionalContext:
      'LEARNING LOOP — CONTEXT COMPRESSION IMMINENT: This session has enough context that compression is needed. Before it happens: (1) Save any uncaptured corrections to auto-memory. (2) Use /learning-loop:quick-note to capture any insights worth keeping. (3) If the session was substantial, suggest /reflect to the user. Do not skip this — compressed context loses the detail that makes good notes.',
  },
};

process.stdout.write(JSON.stringify(output));
