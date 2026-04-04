#!/usr/bin/env bash
set -euo pipefail

BINARY="./target/release/ll-search"
DB="$HOME/brain/brain/.vault-search/vault-index.db"
VAULT="$HOME/brain/brain"
RESULTS_FILE="docs/superpowers/plans/benchmark-baseline.md"

if [ ! -f "$BINARY" ]; then
    echo "Building release binary..."
    cargo build --release
fi

echo "# Benchmark Baseline — $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$RESULTS_FILE"
echo "" >> "$RESULTS_FILE"

# DB stats
NOTE_COUNT=$($BINARY status "$DB" "$VAULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['noteCount'])")
echo "**Vault:** $NOTE_COUNT notes, $(du -h "$DB" | cut -f1) index" >> "$RESULTS_FILE"
echo "**Binary:** $(du -h "$BINARY" | cut -f1)" >> "$RESULTS_FILE"
echo "**Hardware:** $(sysctl -n machdep.cpu.brand_string), $(sysctl -n hw.memsize | awk '{print $1/1073741824 " GB RAM"}')" >> "$RESULTS_FILE"
echo "" >> "$RESULTS_FILE"

echo "## Results" >> "$RESULTS_FILE"
echo "" >> "$RESULTS_FILE"
echo "| Operation | Time | Notes |" >> "$RESULTS_FILE"
echo "|-----------|------|-------|" >> "$RESULTS_FILE"

# Benchmark helper: run N times, report median
bench() {
    local label="$1"
    shift
    local times=()
    local n=5

    # warmup
    "$@" > /dev/null 2>&1 || true

    for i in $(seq 1 $n); do
        local start=$(python3 -c "import time; print(time.time())")
        "$@" > /dev/null 2>&1
        local end=$(python3 -c "import time; print(time.time())")
        local elapsed=$(python3 -c "print(f'{($end - $start)*1000:.1f}')")
        times+=("$elapsed")
    done

    # Sort and pick median
    local sorted=($(printf '%s\n' "${times[@]}" | sort -n))
    local median=${sorted[$(( n / 2 ))]}
    local all=$(printf '%s, ' "${times[@]}")

    echo "| $label | ${median}ms | runs: ${all%, } |" >> "$RESULTS_FILE"
    echo "  $label: ${median}ms (runs: ${all%, })"
}

echo ""
echo "Running benchmarks (5 runs each, reporting median)..."
echo ""

# 1. Simple query
bench "query (simple)" $BINARY query "$DB" "sleep architecture" --top 10

# 2. Query with temporal filter
bench "query (temporal)" $BINARY query "$DB" "autism diagnosis" --top 10 --recency 30

# 3. Similar notes
bench "similar" $BINARY similar "$DB" "3-permanent/autistic-burnout-is-pervasive-exhaustion-from-masking.md" --top 10

# 4. Cluster
bench "cluster (0.90)" $BINARY cluster "$DB" --threshold 0.90

# 5. Discriminate (full vault)
bench "discriminate (full)" $BINARY discriminate "$DB" --threshold 0.90

# 6. Discriminate (scoped, 20 notes)
SCOPE_PATHS=$($BINARY query "$DB" "sleep" --top 20 2>/dev/null | python3 -c "import sys,json; [print(r['path']) for r in json.load(sys.stdin)]" | head -20 | tr '\n' ' ')
bench "discriminate (20 notes)" $BINARY discriminate "$DB" --threshold 0.85 $SCOPE_PATHS

# 7. Rerank
bench "rerank (top 5 from 20)" $BINARY rerank "$DB" "bayesian inference sleep" --top 5 --candidates 20

# 8. Status (no ONNX needed)
bench "status" $BINARY status "$DB" "$VAULT"

# 9. Tags
bench "tags" $BINARY tags "$DB" --min-count 3

# 10. Index (incremental, no changes)
bench "index (no-op)" $BINARY index "$VAULT" "$DB" --incremental

echo "" >> "$RESULTS_FILE"
echo "## System" >> "$RESULTS_FILE"
echo '```' >> "$RESULTS_FILE"
echo "rustc: $(rustc --version)" >> "$RESULTS_FILE"
echo "os: $(sw_vers -productName) $(sw_vers -productVersion)" >> "$RESULTS_FILE"
echo "arch: $(uname -m)" >> "$RESULTS_FILE"
echo '```' >> "$RESULTS_FILE"

echo ""
echo "Baseline saved to $RESULTS_FILE"
cat "$RESULTS_FILE"
