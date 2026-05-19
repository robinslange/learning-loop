---
name: federation
description: "Set up or repair learning-loop federation: identity creation, token redemption, Tailscale, visibility rules, and the first sync test. Run when /init asked you to defer federation, when sync is broken, or when rotating identity. Safe to re-run."
---

# Federation Setup

Federation lets you share vault notes with other learning-loop users via interchange.live. The setup is non-trivial because it spans cryptography (Ed25519 keypair), single-use redemption tokens, an overlay network (Tailscale via headscale), and a hub round-trip that must succeed before any config is written.

This skill is invoked from `/init` Phase 4 when the user opts in, but is safe to run standalone any time you have a token from robin.

## Paths

`PLUGIN`, `PLUGIN_DATA`, and `VAULT` are injected by the session-start hook. If not present, resolve them via `node PLUGIN/scripts/resolve-paths.mjs`.

## Process

Detect, then walk the steps in order. Do not write the federation config until the sync test in step F succeeds: failed runs leave nothing on disk so re-running starts fresh.

## A: Detect

If `PLUGIN_DATA/federation/config.json` already exists, report identity and peer count, and ask: "Federation is already configured. Re-run setup anyway?" Default no. If the user says no, exit cleanly.

## B: Token

Ask: "Do you have an invite token?"

**If no:**

```
You'll need an invitation to join the federation. Apply at:
  https://interchange.live/apply

Once your application is approved, you'll receive a redeem URL.
Re-run /learning-loop:federation when you have it.
```

Exit cleanly.

**If yes:** proceed to identity setup.

## C: Identity

The seed file MUST live in `PLUGIN_DATA/federation/.seed` (persists across plugin updates), NOT in `PLUGIN/federation/.seed` (gets wiped on reinstall).

**Migration check:** If `PLUGIN/federation/.seed` exists but `PLUGIN_DATA/federation/.seed` does not, migrate it:

1. Copy the seed to `PLUGIN_DATA/federation/.seed` (mode 0o600)
2. Delete the old one from the marketplace directory
3. Verify the pubkey matches `config.identity.pubkey` if a previous federation config exists. If it does not match, warn and offer to update the hub.

Run `ll-search identity --config-dir $PLUGIN_DATA` to load or create the Ed25519 keypair. Output is JSON:

```json
{ "pubkey_b64": "0JuQ...r5o=", "seed_path": "...", "created": false }
```

The binary's `pubkey_b64` becomes `pubkey` in config.json (written in step G).

The `pubkey_b64` value is the raw 32-byte public key as base64, ready to send to `/api/redeem` as-is. The command is idempotent: if `.seed` already exists it reuses it (`created: false`), otherwise it creates one with mode `0o600` (`created: true`). Existing seeds created by prior runs continue to work.

## D: Redeem

Ask for the token. POST to `https://interchange.live/api/redeem` with a **30-second timeout** so a hung connection cannot stall the whole flow:

```js
const res = await fetch('https://interchange.live/api/redeem', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token, peer_id, pubkey: pubkey_b64 }),
  signal: AbortSignal.timeout(30_000),
});
```

The `peer_id` is bound to the token server-side: the user does not choose it. The redeem response returns the `peer_id` along with the headscale auth key and hub endpoint. Store these in memory for the rest of the flow. Do NOT write config yet: wait for the sync test to succeed.

Handle server errors:

- `404`: "invalid token, check the URL you were sent"
- `409`: "this token was already redeemed. If a previous setup redeemed but failed at sync, contact robin for a fresh token; the burned one cannot be replayed."
- `410`: "this token has expired, contact robin for a new one"
- `502`: "provisioning service is unreachable, try again later"

On `AbortError` (timeout) or any network error: surface "interchange.live unreachable, retry later" and exit without writing config. The token has not been spent on a connection failure: the same token will work on the next run.

On HTTP failure: exit without writing config.

## E: Network Connection

Check for Tailscale. If not installed, guide installation (brew for macOS, curl for Linux). Run:

```bash
tailscale up --auth-key <headscale_auth_key> --login-server https://hs.interchange.live
```

Verify with `tailscale status`. If it fails, the auth key may have expired (24-hour window): surface the error and exit without writing config. The redeem token has already been consumed, so retrying needs a fresh token from robin (the same `409` rule as step D applies).

## E.5: Visibility Rules

Present defaults:

- `3-permanent/` -> public (full content shared)
- `1-fleeting/` -> listed (title + tags + summary)
- Everything else -> private

Ask: "Does that work for you?" Allow pattern customization if not.

## E.7: Knowledge Graph Opt-in

Ask: "Would you like your public note titles to appear on the interchange.live knowledge graph? (This only shares titles of notes marked public or listed, no content.)"

If yes, set `"graph": true` in the generated config. If no, set `"graph": false`.

## E.8: Provenance Consent

Ask: "Share anonymized pipeline stats? (Tier 1: action counts only)"

## F: First Sync Test

The federation config is **not yet on disk**. Run the sync test against the in-memory identity and the hub endpoint from the redeem response, with a **15-second timeout** so a stalled connection cannot hang setup:

```js
const { spawn } = await import('node:child_process');
const child = spawn(LL_SEARCH, ['sync', dbPath, vaultPath, '--hub-endpoint', hubEndpoint, '--peer-id', peerId], {
  env: { ...process.env },
});
const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
// await close, clearTimeout(timer) on exit
```

(Or invoke the binary via the existing helper and pass the same 15s deadline.)

On success: report counts (notes exported, peers downloaded). Proceed to G.

On failure or timeout: **do not write config**. Surface the specific error and offer the user a choice:

1. **Retry sync now**: re-run F against the same in-memory identity (no token re-burn, no re-redeem). Useful for transient network blips.
2. **Exit setup**: leave federation unconfigured. The redeem token has been spent. To complete federation later the user must contact robin for a fresh token; a re-run of this skill will see no `PLUGIN_DATA/federation/config.json` and start from scratch, but the burned token will return `409` on redeem.

Be explicit about the trade: "The token is single-use and was consumed. If sync keeps failing, you can either retry now or get a new token from robin: there is no way to replay this one."

## G: Write Config

Only reached if F succeeded. Write `PLUGIN_DATA/federation/config.json` with identity (using the `peer_id` returned from D), visibility, `graph`, `share_provenance` fields, and hub endpoint from the redeem response.

Immediately after the config write, stamp the seed with version metadata so SessionStart can surface a one-shot notice on a future plugin major upgrade. Read the current plugin version from `PLUGIN/package.json` and write `PLUGIN_DATA/federation/.seed-meta.json`:

```javascript
const pluginVersion = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf-8')).version;
const meta = {
  created_at: new Date().toISOString(),
  plugin_version: pluginVersion,
  plugin_major: parseInt(pluginVersion.split('.')[0], 10),
};
writeFileSync(
  join(PLUGIN_DATA, 'federation', '.seed-meta.json'),
  JSON.stringify(meta, null, 2),
);

// Successful (re-)setup clears any prior version-mismatch notice
const noticePath = join(PLUGIN_DATA, 'federation', '.seed-notice-shown');
if (existsSync(noticePath)) unlinkSync(noticePath);
```

**Why:** the SessionStart hook compares `meta.plugin_major` against the running plugin's major version and emits a single stderr line when they differ, suggesting `/learning-loop:federation` to rotate. Resetting `.seed-notice-shown` on every successful re-setup guarantees a future major bump (e.g. v2.x -> v3.x after the user already cleared a v1.x -> v2.x notice) re-fires correctly. The notice is informational only: nothing auto-rotates.

**Key behavioural detail:** the federation config file is the canonical "federation is set up" marker, and it is only written once a sync round-trip has actually worked. Failed setup runs leave no config behind, so re-running this skill from a fresh shell always re-enters cleanly. The seed at `PLUGIN_DATA/federation/.seed` is reused across re-runs (it is the user's identity, not federation state), so a re-run produces the same pubkey: the user will need a fresh token if the previous one was already redeemed.

## Summary

After F succeeds and G writes config, report:

```
Federation configured.

  Identity:   [pubkey_b64 first 12 chars]
  Hub:        [endpoint]
  Peers:      [N] downloaded
  Visibility: [public/listed/private folder counts]
  Graph:      [yes/no]
```

## Rules

- Never write the federation config until the sync test passes. Failed runs must leave no state on disk.
- Tokens are single-use and consumed on redeem (step D). Network failures BEFORE redeem are recoverable; failures AFTER redeem require a fresh token.
- The seed file is the user's identity. Never delete `PLUGIN_DATA/federation/.seed` without explicit user request.
- Tailscale auth keys expire in 24 hours. If step E fails for that reason, the token is already spent.
