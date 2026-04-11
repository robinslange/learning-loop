#!/bin/bash
# Benchmark: hybrid-only vs hybrid+rerank
# Tests 15 queries across 5 categories against live vault index

DB="$HOME/brain/brain/.vault-search/vault-index.db"
BINARY="${1:-$(dirname "$0")/../target/release/ll-search}"
TOP=10
CANDIDATES=20

echo "=== Reranker Benchmark ==="
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Binary: $BINARY"
echo "Top: $TOP, Candidates: $CANDIDATES"
echo ""

queries=(
  # Category 1: Technical term queries (BM25 should dominate)
  "kynurenine pathway neuroinflammation"
  "GABA glutamate excitation inhibition balance"
  "FTS5 BM25 sqlite full text search"

  # Category 2: Conceptual/semantic queries (embeddings should dominate)
  "how to track cognitive performance over time"
  "what makes a good experiment design for self tracking"
  "building trust through consistent small actions"

  # Category 3: Ambiguous queries (reranker should help most)
  "bayesian"
  "pipeline"
  "federation"

  # Category 4: Cross-domain queries (tests retrieval breadth)
  "autism and sensory processing differences"
  "supplement timing and absorption"
  "dark patterns in product design"

  # Category 5: Long natural language queries
  "how does the on-device bayesian inference pipeline work in thalen and what parameters does it estimate"
  "what evidence exists that self-monitoring changes behavior independent of the accuracy of the measurements"
  "why is concept creep problematic and how does it relate to diagnostic bracket creep in mental health"
)

total_hybrid_ms=0
total_rerank_ms=0
total_promotions=0

for q in "${queries[@]}"; do
  echo "--- Query: $q"

  # Hybrid only
  start=$(python3 -c "import time; print(int(time.time()*1000))")
  hybrid=$("$BINARY" query "$DB" "$q" --top "$TOP" 2>/dev/null)
  end=$(python3 -c "import time; print(int(time.time()*1000))")
  hybrid_ms=$((end - start))
  total_hybrid_ms=$((total_hybrid_ms + hybrid_ms))

  # Hybrid + rerank
  start=$(python3 -c "import time; print(int(time.time()*1000))")
  reranked=$("$BINARY" rerank "$DB" "$q" --top "$TOP" --candidates "$CANDIDATES" 2>/dev/null)
  end=$(python3 -c "import time; print(int(time.time()*1000))")
  rerank_ms=$((end - start))
  total_rerank_ms=$((total_rerank_ms + rerank_ms))

  echo "  Hybrid (${hybrid_ms}ms):"
  echo "$hybrid" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for i, r in enumerate(data[:5]):
    path = r.get('path', '?')
    score = r.get('score', 0)
    print(f'    {i+1}. [{score:.4f}] {path}')
"

  echo "  Reranked (${rerank_ms}ms):"
  echo "$reranked" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for i, r in enumerate(data[:5]):
    path = r.get('path', '?')
    score = r.get('score', 0)
    print(f'    {i+1}. [{score:.4f}] {path}')
"

  # Compute rank changes
  promotions=$(python3 -c "
import json
h = json.loads('''$hybrid''')
r = json.loads('''$reranked''')
h_paths = [x['path'] for x in h[:5]]
r_paths = [x['path'] for x in r[:5]]
new_in_top5 = [p for p in r_paths[:5] if p not in h_paths[:5]]
if new_in_top5:
    print(f'  Reranker promoted {len(new_in_top5)} note(s) to top-5:')
    h_all = [x['path'] for x in h[:$CANDIDATES]]
    for p in new_in_top5:
        old_rank = h_all.index(p) + 1 if p in h_all else '>$CANDIDATES'
        print(f'    {p} (was rank {old_rank})')
    print(len(new_in_top5))
else:
    print('  No rank changes in top-5')
    print(0)
" 2>/dev/null)

  # Print all but last line (which is the count)
  echo "$promotions" | sed '$d'
  count=$(echo "$promotions" | tail -1)
  total_promotions=$((total_promotions + count))

  echo ""
done

echo "=== Summary ==="
echo "Queries: ${#queries[@]}"
echo "Avg hybrid latency: $((total_hybrid_ms / ${#queries[@]}))ms"
echo "Avg rerank latency: $((total_rerank_ms / ${#queries[@]}))ms"
echo "Avg rerank overhead: $(( (total_rerank_ms - total_hybrid_ms) / ${#queries[@]} ))ms"
echo "Total top-5 promotions: $total_promotions across ${#queries[@]} queries"
