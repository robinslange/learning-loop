# Federation (experimental)

A curated knowledge network for sharing verified insights across vaults. Federation is invite-only -- a hub admin provisions your network access and registers your identity on the hub. Notes that reach your peers have already passed source verification and quality gating. See [interchange.live](https://interchange.live) for more.

## What you get

- **Federated search** -- your vault search results include relevant notes from peers, ranked by reciprocal rank fusion with provenance tracking
- **Visibility control** -- you decide what to share. Three tiers: `public` (full content), `listed` (title + summary only), `private` (not shared). Glob rules + per-note frontmatter overrides
- **Automatic sync** -- session hooks handle reindexing, exporting, and syncing. No manual commands needed
- **Ed25519 identity** -- each peer has a persistent cryptographic identity. All index exchanges are signed and verified

## How it works

Each peer exports a filtered index of their vault (respecting visibility rules) and uploads it to a coordination hub over encrypted WireGuard tunnels. Peers download each other's indexes and search locally. No note content leaves your machine unless you mark it public. The hub only stores indexes, not vault contents.

## Setup

Federation is configured during `/learning-loop:init` (Phase 4):

1. Connect to the network with a pre-auth key (provided by the hub admin)
2. Generate an Ed25519 identity
3. Send your public key to the hub admin for registration (manual step -- there is no self-registration)
4. Configure visibility rules
5. Test sync (re-run `/learning-loop:init` after the admin confirms registration)

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

Frontmatter `visibility: private` on any note overrides glob rules.

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
ll-search index ~/brain/brain ~/brain/brain/.vault-search/vault-index.db --sync
ll-search sync <db> <vault>
ll-search export <db> <output> <vault>
ll-search watch <vault> <db> --sync-interval 300
```

Sync runs automatically: reindex on session start, export+sync on session end (unless watch mode is running).
