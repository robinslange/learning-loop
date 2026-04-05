#!/usr/bin/env node
// post-search-tracking.js — Track episodic memory search queries

import { runHook, emitRetrieval } from './lib/common.mjs';

runHook(({ tool, input }) => {
  const query = input.query || input.message || input.text || '';
  if (query) emitRetrieval('episodic-queries', { type: 'episodic-search', tool, query });
});
