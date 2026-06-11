# Federation (experimental)

A curated knowledge network for sharing verified insights across vaults. Federation is invite-only -- onboarding runs through [interchange.live](https://interchange.live), which issues one-time redeem tokens that self-register your peer without any manual hub-admin step. Notes that reach your peers have already passed source verification and quality gating.

## interchange.live

`interchange.live` is the coordination service the federation runs on. It's the reason onboarding is self-service, and it's the reason your vault's contents never leave your machine: it handles *identity and routing*, not content.

Three responsibilities:

1. **Invitation issuance.** An existing peer (or the admin) generates a redeem token bound to a display name and an expiry. You paste the token into `/learning-loop:federation`. Tokens are one-shot -- once redeemed, they're burned.
2. **Pubkey registration and network provisioning.** The redeem endpoint (`interchange.live/api/redeem`) accepts your raw Ed25519 public key (extracted locally via `ll-search identity`) and returns a [headscale](https://headscale.net) pre-auth key. Headscale is a self-hosted coordination server for [tailscale](https://tailscale.com) -- your peer connects over a WireGuard mesh, not over the public internet. Each peer's identity is cryptographic, not credential-based.
3. **Index exchange rendezvous.** Peers sync their filtered index databases (titles, embeddings, tags, graph edges -- never body text unless a note is `public`) over the tailnet. The interchange service only facilitates the handshake; the actual index transfer is peer-to-peer.

The optional [interchange.live/graph](https://interchange.live/graph) surface is a separate, read-only visualization. Peers opt in by setting `"graph": true` in their config. Only note *titles* and the edges between them leave the machine -- no content, no summaries. Toggling off removes your contribution on the next sync.

What the interchange service deliberately does *not* do:

- Store your vault content. Public-tier notes live in your own index DB; peers pull them on demand.
- Decrypt anything. WireGuard terminates on the peers, not on the coordinator.
- Operate without your key. You can revoke participation by rotating the seed (see [Seed storage](#seed-storage) below) and re-running `/learning-loop:federation`.

The architecture mirrors Signal's sealed-sender or Matrix's federated-room model: a neutral rendezvous, not a content host. The trust boundary is the tailnet; the content boundary is your disk.

## What you get

- **Federated search** -- your vault search results include relevant notes from peers, ranked by reciprocal rank fusion with provenance tracking
- **Visibility control** -- you decide what to share. Three tiers: `public` (full content), `listed` (title + summary only), `private` (not shared). Glob rules + per-note frontmatter overrides
- **Automatic sync** -- the always-on `ll-search watch` daemon reindexes incrementally and syncs with the hub on its periodic ticks. No manual commands needed
- **Ed25519 identity** -- each peer has a persistent cryptographic identity. All index exchanges are signed and verified

## How it works

Each peer exports a filtered index of their vault (respecting visibility rules) and uploads it to a coordination hub over encrypted WireGuard tunnels. Peers download each other's indexes and search locally. No note content leaves your machine unless you mark it public. The hub only stores indexes, not vault contents.

## Setup

Federation is configured during `/learning-loop:federation`. Onboarding is self-service via `interchange.live` invitation tokens:

1. Paste an invitation redeem token from `interchange.live`
2. Init extracts your Ed25519 pubkey via `ll-search identity` (creating the seed on first run) and posts it to `interchange.live/api/redeem`, which returns a headscale pre-auth key
3. `tailscale up` connects you to the network
4. Init configures default visibility rules
5. Sync test confirms peer reachability

Re-running `/learning-loop:federation` on an existing peer skips the token prompt. The previous manual hub-admin registration step is gone.

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

On every session start, `hooks/session-start.js` compares the recorded `plugin_major` against the current plugin version. If they differ, it prints a one-line notice to stderr:

```
learning-loop federation: seed created on plugin v1.18.0 (current: v2.0.0). Run /learning-loop:federation to rotate.
```

The notice fires once per major bump. After it prints, the hook writes `.seed-notice-shown` so the same major mismatch does not nag on every session. Rotating via `/learning-loop:federation` removes the marker, so the next major bump fires a fresh notice.

Federations created before this marker existed get a backfill: the hook stamps `.seed-meta.json` with the current version on first run after upgrade, so the notice stays silent until the next major bump.

### Rotating

Re-run `/learning-loop:federation`. The skill regenerates the seed (after a confirm prompt), repeats the redeem step if needed, and overwrites `.seed-meta.json` with the new version. The previous seed entry is removed from the active backend in the same transaction.

## Sync wire format

Federation sync runs over WebSocket on the tailnet. The transport stack migrated from synchronous `tungstenite` to async `tokio_tungstenite` in v1.19.0; sync now runs as a `tokio::select!` loop alongside the watcher debounce, the poll tick, and the resync tick.

The wire format negotiates a `protocol_version` on `SyncHello` / `SyncReady`:

- **v1** (legacy) -- raw JSON / binary frames; the hub omits `protocol_version` from `SyncReady` and clients read it as `1`.
- **v2** -- length-prefixed envelopes for client uploads and hub-to-client peer downloads: `u32 size (big-endian, 4 bytes) + sha256 (32 bytes) + body`. The receiver validates total length and SHA256 before allocating the body, so a malicious size declaration cannot trigger a 4 GB `Vec::with_capacity`.

Three caps apply on the v2 path:

| Cap | Default | Where |
|---|---|---|
| `MAX_ENVELOPE_SIZE` | 200 MB | Policy ceiling for envelope decode |
| `HUB_INBOUND_CAP` | 50 MB | Axum-enforced ceiling on uploads (smaller wins) |
| Recv / send timeouts | 30 s / 60 s | `LL_SYNC_RECV_TIMEOUT_MS` / `LL_SYNC_SEND_TIMEOUT_MS` override per process |

Uploads larger than 50 MB return `SyncError::EnvelopeOversize { cap }` pre-flight without opening the WebSocket. Timestamp comparison on peer freshness parses unix seconds (rejects garbage with `SyncError::BadTimestamp`) instead of by-string equality, so trailing `Z`, fractional seconds, and `±HH:MM` offsets all compare correctly.

## Visibility rules

Default configuration in `PLUGIN_DATA/federation/config.json`:

```json
{
  "visibility": {
    "default": "private",
    "rules": [
      { "pattern": "3-permanent/**", "tier": "public" },
      { "pattern": "1-fleeting/**", "tier": "listed" }
    ]
  }
}
```

**Resolution order:** rules are evaluated top-to-bottom, **last match wins**, and frontmatter `visibility:` on a note overrides all globs. In practice this means you can layer broad allows with narrow denies — e.g. share `3-permanent/**` publicly but carve out project-prefix notes:

```json
{
  "visibility": {
    "default": "private",
    "rules": [
      { "pattern": "3-permanent/**", "tier": "public" },
      { "pattern": "1-fleeting/**", "tier": "listed" },
      { "pattern": "**/projectname-*", "tier": "private" },
      { "pattern": "**/client-name-*", "tier": "private" }
    ]
  }
}
```

Globs match against the note's vault-relative path. For fuzzier privacy decisions (one-off notes where a glob would false-positive), add `visibility: private` to the note's frontmatter -- it's more precise and survives file renames.

## Knowledge graph

A shared visualization of cross-vault connections at [interchange.live/graph](https://interchange.live/graph). The graph shows note titles only -- no content, summaries, or body text leaves your machine. Connections are drawn from shared tags and embedding similarity between notes across vaults.

### Opting in

Add `"graph": true` to your federation config:

```json
{
  "visibility": { ... },
  "graph": true
}
```

Graph visibility is two-gated: a note appears in the graph only if **both** conditions are met:

1. The note's visibility tier is `public` or `listed` (private notes are never included)
2. The peer has `"graph": true` in their config

Disabling graph participation is instant -- set `"graph": false` or remove the key. Your titles are removed from the graph on next sync.

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
```

Sync runs automatically inside the always-on `ll-search watch` daemon (spawned at SessionStart by `hooks/session-start/watch-daemon.mjs`): the watcher's `tokio::select!` loop runs sync alongside the reindex debounce, the poll tick, and the resync tick (see [Sync wire format](#sync-wire-format)). Nothing syncs at session end -- the Stop hook only emits nudges. The manual commands above cover the cases where the daemon isn't running.

## Retractions

`scripts/retraction-notify.mjs` emits a retraction event when a note that previously reached peers is retracted. Events append to `PLUGIN_DATA/federation/outbox/retractions-YYYY-MM.jsonl`, targeted at each peer whose index contains the retracted note:

```bash
node scripts/retraction-notify.mjs <note_path> [--reason "<reason>"] [--replacement <new_note_path>]
```

Emission is not yet wired into `/learning-loop:rewrite`; hooking retraction events into the rewrite flow is future federation work.
