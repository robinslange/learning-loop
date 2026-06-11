# Learned Patterns

Positive behavior-based principles derived from verification feedback.
Injected into session context via SessionStart hook. Hard cap: 10 patterns.

<!-- Patterns are added via /health --provenance when a recommendation is approved. -->
<!-- Each pattern tracks: triggered count, last_seen date. -->
<!-- When at cap, lowest triggered + oldest last_seen retires to retired-patterns.md. -->
<!-- Patterns with zero occurrences over 2 months retire automatically. -->
