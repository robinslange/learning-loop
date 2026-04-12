# Federation (experimental)

A curated knowledge network for sharing verified insights across vaults. Federation is invite-only -- onboarding runs through [interchange.live](https://interchange.live), which issues one-time redeem tokens that self-register your peer without any manual hub-admin step. Notes that reach your peers have already passed source verification and quality gating.

## interchange.live

`interchange.live` is the coordination service the federation runs on. It's the reason onboarding is self-service, and it's the reason your vault's contents never leave your machine: it handles *identity and routing*, not content.

Three responsibilities:

1. **Invitation issuance.** An existing peer (or the admin) generates a redeem token bound to a display name and an expiry. You paste the token into `/learning-loop:init` Phase 4. Tokens are one-shot -- once redeemed, they're burned.
2. **Pubkey registration and network provisioning.** The redeem endpoint (`interchange.live/api/redeem`) accepts your raw Ed25519 public key (extracted locally via `ll-search identity`) and returns a [headscale](https://headscale.net) pre-auth key. Headscale is a self-hosted coordination server for [tailscale](https://tailscale.com) -- your peer connects over a WireGuard mesh, not over the public internet. Each peer's identity is cryptographic, not credential-based.
3. **Index exchange rendezvous.** Peers sync their filtered index databases (titles, embeddings, tags, graph edges -- never body text unless a note is `public`) over the tailnet. The interchange service only facilitates the handshake; the actual index transfer is peer-to-peer.

The optional [interchange.live/graph](https://interchange.live/graph) surface is a separate, read-only visualization. Peers opt in by setting `"graph": true` in their config. Only note *titles* and the edges between them leave the machine -- no content, no summaries. Toggling off removes your contribution on the next sync.

What the interchange service deliberately does *not* do:

- Store your vault content. Public-tier notes live in your own index DB; peers pull them on demand.
- Decrypt anything. WireGuard terminates on the peers, not on the coordinator.
- Operate without your key. You can revoke participation by rotating the seed at `PLUGIN_DATA/federation/.seed` and re-running `/learning-loop:init`.

The architecture mirrors Signal's sealed-sender or Matrix's federated-room model: a neutral rendezvous, not a content host. The trust boundary is the tailnet; the content boundary is your disk.

## What you get

- **Federated search** -- your vault search results include relevant notes from peers, ranked by reciprocal rank fusion with provenance tracking
- **Visibility control** -- you decide what to share. Three tiers: `public` (full content), `listed` (title + summary only), `private` (not shared). Glob rules + per-note frontmatter overrides
- **Automatic sync** -- session hooks handle reindexing, exporting, and syncing. No manual commands needed
- **Ed25519 identity** -- each peer has a persistent cryptographic identity. All index exchanges are signed and verified

## How it works

Each peer exports a filtered index of their vault (respecting visibility rules) and uploads it to a coordination hub over encrypted WireGuard tunnels. Peers download each other's indexes and search locally. No note content leaves your machine unless you mark it public. The hub only stores indexes, not vault contents.

## Setup

Federation is configured during `/learning-loop:init` (Phase 4). Onboarding is self-service via `interchange.live` invitation tokens:

1. Paste an invitation redeem token from `interchange.live`
2. Init extracts your Ed25519 pubkey via `ll-search identity` (creating the seed on first run) and posts it to `interchange.live/api/redeem`, which returns a headscale pre-auth key
3. `tailscale up` connects you to the network
4. Init configures default visibility rules
5. Sync test confirms peer reachability

Re-running `/learning-loop:init` on an existing peer skips the token prompt. The previous manual hub-admin registration step is gone.

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

# Watch mode with periodic sync (calls ll-search watch internally)
node scripts/vault-search.mjs index --watch --sync
```

Sync runs automatically: reindex on session start, export+sync on session end (unless watch mode is running).
