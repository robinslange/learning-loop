// DEPRECATED — use scripts/librarian/tools/*
// This shim re-exports the full original surface for one release (phase 1H).
// Scheduled for removal in phase 2 per .planning/refactors/baseline-2026-05-11.md.
export {
  TOOL_DEFS,
  executeTool,
  submitVoiceFlag,
  submitTagSuggestion,
  submitDuplicateFlag,
} from '../librarian/tools/index.mjs';
export { extractModelProb } from '../librarian/tools/model-prob.mjs';
