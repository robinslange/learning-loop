# Bench fixtures

Synthetic vault generator for the bench harness.

## Usage

```bash
# Small vault (100 notes, for quick tests)
node generate-vault.mjs --count 100 --out .cache/vault-small --seed 20260511

# Large vault (10k notes, for baseline benches)
node generate-vault.mjs --count 10000 --out .cache/vault-10k --seed 20260511
```

## Properties

- Deterministic: same seed = same output on every machine.
- Idempotent: re-running with the same count+seed is a no-op (manifest check).
- Each note: YAML frontmatter (title, tags 1-4, mtime), body 200-800 words, 5-15 wikilinks.
- Tags drawn from 30-word vocabulary.
- Body drawn from 150-word technical vocabulary + 8 sentence templates.

## What is and is not committed

Committed:
- `generate-vault.mjs` — the generator
- `.gitignore` — ignores `.cache/`
- `README.md` — this file

Not committed (generated on first bench run):
- `.cache/vault-small/` — 100-note vault
- `.cache/vault-10k/` — 10k-note vault

## Regenerating

Delete the relevant `.cache/` subdirectory. The generator will recreate it.

## Limitations

The synthetic vault does not reproduce:
- Real frontmatter variance (e.g. nested YAML arrays, unicode titles)
- Actual English prose distribution (BM25 behaviour will differ from real vaults)
- Wikilink graphs with real circular references

These limitations are documented in `bench/README.md` under Known Limitations.
