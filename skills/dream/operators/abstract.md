# ABSTRACT — Synthesize Higher-Order Patterns

Synthesizes clusters of specific memories into a single higher-order pattern.

## Execution

For each flagged cluster, present the proposed abstraction:
```
ABSTRACT proposal:
Cluster: [list of N memory filenames]
Abstraction: "[one-sentence pattern]"
Archive: [files fully subsumed]
Keep: [files with unique detail]
Proceed? [yes/no/skip]
```
Wait for user confirmation per cluster. This is a separate gate from the Phase 2 approval because abstraction is lossy and irreversible.

If approved:
- Write a new memory file named with the pattern (e.g., `feedback_code_style_philosophy.md`)
- Frontmatter: `type` matches the cluster's type, `confidence: strong` (validated by user), `abstracted_from:` lists the source filenames
- Body: the abstraction as a clear rule/principle, with Why and How to apply lines
- Body must reference the specific source memories that were synthesized ("Synthesized from N memories about X, Y, Z")
- Archive the fully-subsumed source files to `_archived/`
- Leave the unique-detail files in place, add `related:` pointing to the new abstraction

## Log format

```markdown
### ABSTRACT
- Cluster: feedback_a.md, feedback_b.md, feedback_c.md, feedback_d.md -> feedback_code_economy.md
  - Pattern: "Robin prefers minimal code with no speculative abstractions"
  - Archived: feedback_a.md, feedback_b.md (fully subsumed)
  - Kept: feedback_c.md, feedback_d.md (unique detail)
```
