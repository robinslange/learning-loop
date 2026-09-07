# Federation (experimental)

A curated knowledge network for sharing verified insights across vaults. Federation is invite-only, and notes that reach other people have already passed source verification and quality gating.

## Three nouns

Federation v5 is a **key**, a **vault**, and a **grant**.

- A **key** is a principal -- a person, a machine, later an organisation. The key *is* the identifier: an Ed25519 public key, rendered as a `key_id`. There is no registry, no display name to allocate, and nothing a server assigns you.
- A **vault** is a corpus with an owning key and a visibility policy. One key may own several.
- A **grant** is a signed statement by one key about another. Four kinds: `follow` (read a vault), `link` (these machines are the same person, full authority), `assoc` (these identities are the same human, no authority), `peer` (two hubs bridge).

A **hub** decides one thing: who may connect. It never decides trust between keys. Every grant is signed by the key that made it, the hub stores those exact bytes, and any party can verify a grant offline against nothing but the bytes and the issuer's public half.

Every grant expires, and each successful sync renews the ones it exercised. Defaults: `link` and `assoc` 365 days, `follow` and `peer` 90 days. A machine you use never asks again; a machine you stopped using -- stolen, sold, wiped -- lapses on its own with no action required, and dormant follows decay instead of accumulating.

## What you get

- **Federated search** -- your results include notes from vaults you may read, merged into the same reciprocal-rank fusion as your own, with provenance tracking. A result from elsewhere carries a `peer:<vault_id>/` prefix on its path.
- **Visibility control** -- three tiers: `public` (full content), `listed` (title, tags and summary), `private` (not shared). See [Visibility rules](#visibility-rules), and note that a glob can restrict but never publish.
- **Automatic sync** -- the always-on `ll-search watch` daemon reindexes incrementally and syncs on its periodic ticks.
- **One identity, several machines** -- `ll-search link` joins a second machine to the same key through four doors, one of which needs no network at all.

## Getting on a hub

Three doors, and you need one of them:

1. Your key is named in the hub's own `BOOTSTRAP_MEMBERS` at boot.
2. An invite code. Any member may mint one, capped at five outstanding, and there is no admin role -- but the *surface* today is operator-side: the hub operator runs `sync-hub mint-invite <key_id>` on the box and hands you the code. It is twelve Crockford base32 characters as `XXXX-XXXX-XXXX`, single-use, and expires seven days after minting. A remote surface, where a member asks the hub for a code over the wire and signs the request, does not exist yet. The `created_by` on an invite records who it was minted *as*, which is not evidence that member asked for it.
3. A `link` grant from a machine already enrolled -- see [Additional machines](#additional-machines). This needs no invite, because membership follows the link.

## Setup

Run `/learning-loop:federation`, or drive the binary directly:

```bash
ll-search join <hub-endpoint> <invite-code> <vault-path>
```

The three arguments are positional and in that order, and the endpoint must be `wss://`. The command, in order:

1. Fetches the hub's advertised identity and prints its `key_id` and a **six-word fingerprint**, then asks whether those are the six words the hub operator gave you. Anyone who can answer for that address can present a key; the words are how you tell the real hub from that. **The invite code has not left your machine at this point** -- the hub redeems it while handling the hello, so a code offered to an impostor is a code already burned.
2. Loads this machine's Ed25519 identity, or creates one.
3. Prints a **24-word recovery phrase, once**, and asks whether you have written it down. Those words are the only copy that will ever exist. Nothing on disk holds them.
4. Connects, authenticates, and checks the hub's `SyncReady` names the new `vault_id`. Declaring the vault in the hello *is* registering it; there is no second round trip.
5. Writes `config.json` last.

`join` enrols; it does not sync. The first upload is a separate step:

```bash
ll-search sync <db-path> <vault-path>
```

If `join` fails, nothing is written and you can re-run it cleanly. The invite is spent only on success.

A second vault on the same machine needs `ll-search vault add <vault-path> <id>` first: `join` creates the identity, `vault add` creates the registry entry, and a config dir the registry cannot see is refused rather than joined.

## Reading the status

```bash
ll-search status
```

Local files only: no socket, no clock, no network, so nothing it prints can imply a check that did not run. It reports the vault and its `vault_id`, this machine's key and fingerprint, the hub and its pinned key, when the last cycle ran and whether it worked, and what the hub held as of that cycle. Four verdicts are worth knowing by name:

- **`STALE`** -- the last successful sync is more than seven days old, or none has ever succeeded.
- **`hub holds: nothing`** -- as of that cycle the hub had no index for this vault. The next sync re-uploads it. If it survives a successful sync, the hub is degraded. This is the signature of an outage that ran for two months in 2026 while the client reported itself content.
- **`BLOCKED`** -- `ll-search sync` will refuse this config. The two causes are an unpinned `hub.key_id` and an endpoint that is not `wss://`. Both were warnings in v4 and are errors now.
- **`RECOVERED`** -- the seed and `config.json` name different keys.

## Additional machines

A person is a set of machines joined by `link` grants. Four doors, and **the six-word fingerprint is the security boundary in every one of them** -- the transport is not. Both ends print six words over the joining machine's key; the approver confirms they match before approving. If they do not match, stop: something is relaying the pairing.

**Both machines networked, hub reachable.** On the new machine:

```bash
ll-search link request <hub-endpoint> <vault-path>
```

then on a machine already enrolled:

```bash
ll-search link approve <code>
```

**No hub, or no network path between them.** On the new machine, `ll-search link code` needs no network at all; on the established one, `ll-search link approve <code> --offline` signs the grant and prints it instead of lodging it; carry that blob across and run `ll-search link accept <grant>`. The grant verifies against nothing but its own bytes and the issuer's public key, so the new machine can act as itself immediately and reaches the hub once the approver next connects.

A link is two grants, not one signed twice: the approver signs A->B, and the new machine signs B->A itself on finding it. `ll-search link list` shows which halves exist.

### Cutting a machine off

```bash
ll-search link revoke <key_id>
```

It signs a revocation, lodges it with the hub, and *then* drops the local row -- that order, because this store is the only record of what this key issued, and dropping it first would leave nothing to sign a revocation for while the other machine kept authority for a full year.

Two limits worth knowing before you rely on it:

- **It withdraws only the half this machine signed.** The grant the other machine issued to this one is that machine's statement about its own key, and only that machine can withdraw it. `link revoke` says when one is still standing.
- **It deletes nothing from disk.** A `link` is unscoped -- "every vault this issuer owns" -- so it names no directory under `federation/data/peers/` to remove. What stops the data being served is the hub dropping those vaults from this key's listing on the next sync, not the revocation itself.

There is no equivalent for a `follow` someone holds on your vault. Nothing sends one; those lapse at their own expiry.

## Recovering an identity

```bash
ll-search recover "<24 words>"
```

Recovering the identity already on this machine needs nothing extra -- nothing is replaced, so there is nothing to authorise. Recovering a **different** identity over an existing one requires `--force`, and what that guards is the loss, not the write: every grant naming the old key stays signed, valid, and unreachable, while the machine still looks enrolled.

`recover` writes the seed and deliberately leaves `config.json` alone, because the hub pin and `vault_id` in it describe an enrolment the new key was never part of. `ll-search status` prints a `RECOVERED` line when the two disagree.

## Seed storage

Since v1.18.0 the Ed25519 signing seed lives in a secure backend rather than a plaintext file. Backend selection runs at every launch and tries in order:

1. **OS keyring** (`keyring`) -- macOS Keychain via the `keyring` crate, Linux Secret Service when a DBus session is available, Windows Credential Manager. The keyring entry is namespaced by `config_dir` (`signing-seed-v1-<8-hex>` where the hex prefix is sha256 of the canonicalised path), so a leaked tempdir invocation cannot claim a production seed.
2. **Encrypted-at-rest** (`encrypted`) -- chacha20poly1305 AEAD sealed with a machine-derived key (HKDF-SHA256 over `machine-uid`). Used on headless Linux installs without DBus. Protects against backup leak and laptop theft, not against root-on-host.
3. **Plaintext-legacy** -- the pre-v1.18.0 `PLUGIN_DATA/federation/.seed` file. Still readable for un-migrated installs.

`ll-search identity` prints the active backend in its JSON output as `"backend": "keyring" | "encrypted" | "plaintext-legacy"`. Override the selection with the `LL_SEED_BACKEND` env var (accepts `keyring`, `encrypted`, or `mock`); production should leave it unset.

### Migrating a plaintext seed

```bash
ll-search migrate-seed                # move plaintext into the best available backend
ll-search migrate-seed --rollback     # restore plaintext from the secure backend
```

The migration is fail-closed: the plaintext file is deleted only after the new backend has been written and round-trip verified. A `.seed-meta.json` sidecar captures the migration timestamp and target backend. Re-running `migrate-seed` against an already-migrated seed is a no-op.

The legacy un-namespaced keyring entry (`signing-seed-v1`) auto-migrates to the namespaced form on first sync after upgrade, but only when the seed it holds derives a pubkey matching this `config_dir`'s `federation/config.json` -- this stops a leaked tempdir from inheriting the production entry.

### Seed version notice

When `/learning-loop:federation` succeeds, init writes `PLUGIN_DATA/federation/.seed-meta.json`. The file records the backend, the plugin version, and the major number at federation creation time:

```json
{
  "backend": "keyring",
  "created_at": "2026-04-26T03:00:00.000Z",
  "plugin_version": "1.18.0",
  "plugin_major": 1
}
```

On every session start, `hooks/session-start/vault-snapshot.mjs` compares the recorded `plugin_major` against the current plugin version. If they differ, it prints a one-line notice to stderr:

```
learning-loop federation: identity created on plugin v1.18.0 (current: v2.0.0). Nothing rotates an identity — but a config written before v5 will not sync. Run `ll-search status`: it reports BLOCKED when the hub key is unpinned.
```

The notice fires once per major bump. After it prints, the hook writes `.seed-notice-shown` so the same mismatch does not nag every session.

Federations created before this marker existed get a backfill: the hook stamps `.seed-meta.json` with the current version on first run after upgrade, so the notice stays silent until the next major bump.

### There is no rotation

**Nothing rotates an identity, and nothing ever did.** The seed *is* the key: no command replaces one, and `ll-search recover` restores the same key rather than issuing a new one. An earlier version of this page described re-running the setup skill to regenerate the seed; that skill has never had such a step.

If you want a different key on this machine, that is not a rotation -- it is a new identity, and every grant naming the old one survives it, signed and unreachable. `ll-search recover --force` is the only path that does it, and `--force` exists to make the loss deliberate.

## Sync wire format

Federation sync runs over WebSocket, and the endpoint must be `wss://`: confidentiality is the TLS transport, and `check_hub_scheme` refuses a plaintext `ws://` unless `LL_ALLOW_INSECURE_WS` is set. The payload is zstd-compressed, not encrypted -- compressed whole before chunking, so the dictionary context spans the payload. Sync runs as a `tokio::select!` loop inside the watcher, alongside the reindex debounce, the poll tick and the resync tick.

**There is no protocol negotiation and no downgrade.** `PROTOCOL_VERSION` is `5`, both ends declare it, and a mismatch is an error that names both versions and tells you to upgrade one side. The v1/v2 negotiation an earlier version of this page described is gone: a version two peers have to agree on at runtime is a version one of them can be talked down to.

Bodies travel as length-prefixed envelopes -- `u32 size (big-endian) + sha256 (32 bytes) + body` -- and the receiver validates the declared length and the hash before allocating, so a hostile size cannot trigger a huge `Vec::with_capacity`.

| Cap | Default | Where |
|---|---|---|
| `MAX_ENVELOPE_SIZE` | 200 MB | Policy ceiling for envelope decode |
| `HUB_INBOUND_CAP` | 50 MB | Ceiling on uploads (the smaller of the two wins) |
| Recv / send timeouts | 30 s / 60 s | `LL_SYNC_RECV_TIMEOUT_MS` / `LL_SYNC_SEND_TIMEOUT_MS` override per process |

An upload over the inbound cap returns `SyncError::EnvelopeOversize { cap }` pre-flight, without opening the WebSocket.

## Visibility rules

Three tiers: `public` (full content shared), `listed` (title, tags and summary), `private` (not shared at all). A fresh config is `private` by default with no rules.

**Frontmatter is the only route to `public`.** A note is published in full only when it says so itself:

```yaml
---
visibility: public
---
```

**A glob rule may restrict, never publish.** A rule naming `public` is clamped to `listed` on the export path. A misspelled frontmatter value (`visibility: pubic`) falls through to the glob rules *and their clamp* rather than to an uncapped tier, so a typo cannot publish a note either.

**Why the default inverted.** The old policy was a blocklist: `3-permanent/** → public`, then roughly thirty hand-written filename patterns clawing individual notes back to private. That only works if someone anticipates every filename — and promotion into `3-permanent/` is done by an automated pipeline, with filenames generated from note content rather than chosen defensively. Every new sensitive topic needed a new pattern added by hand *before* the note landed. Thirty patches to one missing guard is one design mistake with thirty instances, not thirty problems. Publishing a whole note's body is now an explicit act by its author rather than a consequence of which folder it landed in.

### If you federated before this rule

Your published set was derived from folder globs and is now capped at `listed`. **Notes you believed were shared in full are now shared as title, tags and summary** — less is published than before, not more.

There is a one-time pass that preserves exactly today's published set while leaving the new default in place for everything written afterwards:

```bash
ll-search visibility-backfill <vault-path> --dry-run   # report what would change
ll-search visibility-backfill <vault-path>             # stamp `visibility: public` into those notes
```

**Running it is a choice, not a repair.** It re-publishes every note that resolved to public under the old blocklist, which is the set that policy produced rather than a set anyone reviewed. Read the `--dry-run` output first: this is the moment to decide whether those notes should have their bodies published at all, and that decision is deliberately not automated. Doing nothing is a valid answer — it leaves those notes at `listed`.

On a vault that has never federated there is nothing to preserve; skip it.

### Rules in config

Rules live in `PLUGIN_DATA/federation/config.json` under `visibility.rules`. There is no CLI to edit them; write the file.

```json
{
  "visibility": {
    "default": "private",
    "rules": [
      { "pattern": "1-fleeting/**", "tier": "listed" },
      { "pattern": "**/projectname-*", "tier": "private" },
      { "pattern": "**/client-name-*", "tier": "private" }
    ]
  }
}
```

**Resolution order:** rules are evaluated top-to-bottom, **last match wins**, and frontmatter `visibility:` on a note overrides all globs. So you can layer a broad allow with narrow denies, as above -- but the broad allow tops out at `listed`, whatever tier it names.

Globs match the note's vault-relative path. For fuzzier privacy decisions -- a one-off note where a glob would false-positive -- put `visibility: private` in the note's frontmatter: it is more precise and survives a rename.

## Sync commands

```bash
# Reindex and sync in one step
node scripts/vault-search.mjs index --sync

# Export federation index
node scripts/vault-search.mjs export-index

# Sync with federation hub
node scripts/vault-search.mjs sync

# Watch mode with periodic sync
ll-watch

# Federation status: local files only, no network
ll-search status
```

Note that `node scripts/vault-search.mjs status` is the **index** status, not this one — it shells out to `ll-search index-status`. v5 gave the bare name `status` to federation, and the pre-existing command became `index-status`.

Sync runs automatically inside the always-on `ll-search watch` daemon (spawned at SessionStart by `hooks/session-start/watch-daemon.mjs`): the watcher's `tokio::select!` loop runs sync alongside the reindex debounce, the poll tick, and the resync tick (see [Sync wire format](#sync-wire-format)). Nothing syncs at session end -- the Stop hook only emits nudges. The manual commands above cover the cases where the daemon isn't running.

## The public knowledge map

**Withdrawn, pending a revisit.** Earlier versions of this page described a
shared visualisation of cross-vault connections at `interchange.live/graph`,
and a `graph_opt_in` toggle for putting your note titles on it. The map is
being removed rather than fixed: it is not the part of federation that earns
its keep, and it will be reconsidered from scratch if it comes back.

**The privacy tiers are unaffected.** `private` / `listed` / `public` are the
federation-member privacy model and they stay exactly as
[Visibility rules](#visibility-rules) describes. Nothing about what your peers
can read changes.

The opt-in subcommand is gone with it. An existing `config.json` may still
carry a `graph_opt_in` key; it is ignored on load and dropped the next time the
file is written, so there is nothing to clean up by hand.

## Retractions

`scripts/retraction-notify.mjs` emits a retraction event when a note that previously reached peers is retracted. Events append to `PLUGIN_DATA/federation/outbox/retractions-YYYY-MM.jsonl`, targeted at each peer whose index contains the retracted note:

```bash
node scripts/retraction-notify.mjs <note_path> [--reason "<reason>"] [--replacement <new_note_path>]
```

Emission is wired into `/learning-loop:rewrite`: its execute phase (Phase 5) probes `scripts/federation-active.mjs` and, when the instance is federated, runs `retraction-notify.mjs` for each retracted vault note. The step is fail-soft; a notify failure is reported but never blocks the rewrite.
