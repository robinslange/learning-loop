---
name: federation
description: "Set up or repair learning-loop federation: enrolling a vault on a hub, linking a second machine, visibility rules, and reading sync status. Run when /init asked you to defer federation, when sync is broken, or when adding a machine. Safe to re-run."
---

# Federation Setup

Federation is three nouns. A **key** is a principal — a person or a machine.
The key *is* the identifier: there is no registry and no name to allocate. A
**vault** is a corpus with an owning key and a visibility policy; one key may
own several. A **grant** is a signed statement by one key about another —
`follow` (read a vault), `link` (these machines are the same person), `assoc`
(these identities are the same human, no authority), `peer` (two hubs bridge).

A **hub** decides who may connect. It never decides trust between keys: every
grant is signed by the key that made it and verifies offline against nothing
but the bytes and that key's public half.

This skill is invoked from `/init` Phase 4 when the user opts in, and is safe
to run standalone.

## Paths

Resolve `PLUGIN_DATA`, `VAULT`, and the plugin root per `${CLAUDE_PLUGIN_ROOT}/skills-shared/paths-preamble.md` (read it and apply).

`ll-search` writes everything federation owns under a **config dir**. For a
single-vault install that is `PLUGIN_DATA` itself, and `--config-dir
$PLUGIN_DATA` is what every command below passes. For a multi-vault install
each vault has its own config dir under `PLUGIN_DATA`, listed by `ll-search
vault list`.

`ll-search sync` also takes the **search index** as its first positional. That
is `VAULT/.vault-search/vault-index.db` — the file the watch daemon writes, not
anything under the config dir. Pass it in full; a path that does not exist ends
the command in a panic rather than a message.

## Process

Detect first, then walk the steps in order. Nothing writes `config.json` until
the hub has proved its identity and admitted this key, so a run that dies
part-way leaves a directory the next run enters cleanly.

## A: Detect

- If `PLUGIN_DATA/vaults.json` exists, this is a multi-vault install. Run
  `ll-search vault list` and ask which vault this run is about; use that
  profile's config dir for everything below.
- Otherwise read `PLUGIN_DATA/federation/config.json`.

If a config exists, federation is already set up for that vault. Run

```bash
ll-search status --config-dir <config_dir>
```

and report what it says. **Do not re-enroll.** `ll-search join` refuses a
config dir that already holds a config, and deleting the config to get past
that costs the vault its `vault_id` — the hub's copy of the old one is not
carried across.

`ll-search status` reads local files only. It opens no socket and reads no
clock, so nothing it prints can imply a check that did not run. It reports:
the vault and its `vault_id`, this machine's key, the hub and its pinned key,
when the last cycle ran and whether it succeeded,
what the hub held as of that cycle, and a `BLOCKED` line if `ll-search sync`
would refuse the config.

**The `last sync` line can describe a config that is no longer on disk.** The
watch daemon reads `config.json` once, when it starts, and holds that copy for
its whole life; SessionStart only replaces it when the binary changes, not when
the config does. A daemon that started before this vault joined therefore keeps
dialling the endpoint it read then, and stamps that failure over
`federation/sync-state.json` every five minutes — including over a successful
manual sync.

The tell is inside the output: a `last sync` error naming a hub that is not the
`hub:` line above it is a stale daemon, not a broken config. When that happens,
restart the watcher before reporting anything about the last cycle:

```bash
ll-watch stop && ll-watch
```

then run the sync in section C and re-read `status`.

## B: Invite code

Enrollment needs an invite code — twelve Crockford base32 characters grouped
`XXXX-XXXX-XXXX`. A code is single-use, expires seven days after it is minted,
and is spent only when a key successfully authenticates with it.

**Where a code comes from: ask someone already on the hub.** Any member may
mint one, capped at five outstanding unused invites each; there is no admin
role and no `role` column, so the person who invites a user does not have to be
whoever runs the box. What is still operator-side is the *surface*: minting is
`sync-hub mint-invite <key_id>`, run on the hub itself, so a member without a
shell there asks the operator to mint as them. A remote surface — a member
asking the hub for a code over the wire, and signing the request — does not
exist yet. Tell the user to ask a member they know; tell them the operator is
the fallback, not the rule.

**What `created_by` does and does not mean.** It records the member an invite
was minted *as*. It is not evidence that member asked for it: the command
proves the operator has a shell on the box, not that anyone consented. This
grants the operator no authority they lacked — with the database they could
write a `members` row by hand — but do not tell a user their invite was
authorised by the member it names.

So there are three doors onto a hub:

1. named in the hub's own `BOOTSTRAP_MEMBERS` at boot;
2. an invite code from a member (this section);
3. a `link` grant from a machine already enrolled (section F) — which needs no
   invite at all, because membership follows the link.

**Door 1 is not something a user can look up, and it does not excuse the
argument.** `BOOTSTRAP_MEMBERS` is an environment variable on the hub; nothing
the client runs can read it. The hub admits a key it already knows before it
looks at the code, so a member's `join` succeeds whatever is in the invite
slot — but `join` takes the code as a required positional and there is no flag
to omit it. If the user believes they were admitted at boot and has no code,
have them pass any well-formed `XXXX-XXXX-XXXX` and read the outcome:
`Authenticated` means door 1 was real, `hub rejected: invite redemption failed`
means it was not and they need door 2. Say that is what the argument is doing,
so nobody records a code that was never spent.

If the user has none of the three, stop here rather than starting a `join`
that cannot complete.

## C: Join

Run, and show the user the output as it appears — the two confirmations are
theirs to make, not yours:

```bash
ll-search join <hub-endpoint> <invite-code> <vault-path> --config-dir <config_dir>
```

The three are positional and in that order. The endpoint must be `wss://`.

The command, in order:

1. Fetches the hub's advertised identity and prints its `key_id` and a
   **six-word fingerprint**, then asks whether those are the six words the hub
   operator gave the user. Anyone who can answer for that address can present
   a key; the words are how the real hub is told from that. **The invite code
   has not left the machine at this point** — the hub redeems it while
   handling the hello, so a code offered to an impostor is a code already
   burned. Answering anything but yes sends nothing and writes nothing.
2. Loads this machine's Ed25519 identity, or creates one.
3. Generates a recovery key and prints its **24-word recovery phrase once**,
   then asks whether the user has written it down. The words are the only copy
   that will ever exist; nothing on disk holds them.
4. Connects, authenticates, and checks the hub's `SyncReady` names the new
   `vault_id`. Declaring the vault in the hello *is* registering it — there is
   no second round trip — but a hub that admits the key without creating the
   row is refused here rather than at a first sync a repository away.
5. Writes `config.json` last.

**Never echo the recovery phrase back, never write it to a file, and never put
it in your response.** It is the user's to record.

`join` does **not** sync. It enrolls. Two steps follow it, and neither is
optional.

**First, restart the watch daemon.** It is running — SessionStart spawns it —
and it is holding the config as it was before `join` rewrote it. Left alone it
never picks up the new hub, and its five-minute tick overwrites
`federation/sync-state.json` with a failure against the old endpoint, which is
what `ll-search status` then reports.

```bash
ll-watch stop && ll-watch
```

**Then upload:**

```bash
ll-search sync <VAULT>/.vault-search/vault-index.db <VAULT> --config-dir <config_dir>
```

Report what it returns (notes uploaded, vaults fetched). If it names vaults it
could not fetch, say which — the client was entitled to read them and could
not, and that is the only place it surfaces.

If `join` fails, no config is written and the skill re-runs cleanly. The invite
is spent only on success.

**A second vault on this machine needs `ll-search vault add <vault-path> <id>`
first.** `join` creates the identity; `vault add` creates the registry entry.
A config dir under `PLUGIN_DATA` that no vault profile names is refused rather
than joined, because a vault the registry cannot see is one no later command
can find.

## D: Visibility rules

Three tiers: `public` (full content shared), `listed` (title, tags and summary
only), `private` (not shared at all). A fresh config is `private` by default
with no rules.

**Frontmatter is the only route to `public`.** A note is published in full
only when it says so itself:

```yaml
visibility: public
```

Glob rules may restrict, never publish: a rule naming `public` is clamped to
`listed`. A misspelled frontmatter value (`visibility: pubic`) falls through to
the glob rules *and their clamp* rather than to an uncapped tier, so a typo
cannot publish a note.

Rules live in `config.json` under `visibility.rules` as `{ "pattern": "...",
"tier": "..." }`, last match wins. There is no CLI to edit them; write the file
directly. Suggested starting point, if the user wants one:

```json
"visibility": {
  "default": "private",
  "rules": [{ "pattern": "1-fleeting/**", "tier": "listed" }]
}
```

**If this vault federated before this rule existed**, its published set was
derived from folder globs and is now capped to `listed`. To keep exactly the
notes that were public before, run once:

```bash
ll-search visibility-backfill <vault-path> --config-dir <config_dir> --dry-run
```

It reports what it would write. Re-run without `--dry-run` to stamp
`visibility: public` into the frontmatter of those notes. On a vault that has
never federated there is nothing to preserve — skip it.

## E: Summary

After `join` and the first `sync`, report:

```
Federation configured.

  Key:        [key_id]
  Vault id:   [vault_id]
  Hub:        [endpoint]  ([six-word fingerprint])
  Uploaded:   [N] notes
  Visibility: [public/listed/private counts]
```

Then remind the user, once, that the 24 words are the only way back to this
identity.

## F: Additional machines

A person is a set of machines joined by `link` grants. Four doors, and the
**six-word fingerprint is the security boundary in every one of them** — the
transport is not. Both ends print six words over the joining machine's key;
the approver confirms they match before approving. If they do not match, stop:
something is relaying the pairing.

**Both machines on a network, hub reachable** — on the new machine:

```bash
ll-search link request <hub-endpoint> <vault-path> --config-dir <config_dir>
```

It prints a pairing code and a QR, plus the hub this identity will reach once
admitted. On a machine already enrolled:

```bash
ll-search link approve <code> --config-dir <config_dir>
```

The approver lodges the grant with the hub; the new machine collects it on its
next sync.

**No hub, or no network path between the machines** — on the new machine:

```bash
ll-search link code --config-dir <config_dir>
```

which needs no network at all. Then on the established machine:

```bash
ll-search link approve <code> --offline --config-dir <config_dir>
```

which signs the grant and prints it instead of lodging it. Carry that blob to
the new machine:

```bash
ll-search link accept <grant> --config-dir <config_dir>
```

The grant verifies against nothing but its own bytes and the issuer's public
key. The new machine can act as itself immediately, and reaches the hub once
the approver next connects and lodges what it signed.

**What the machines are linked to:**

```bash
ll-search link list --config-dir <config_dir>
```

A link is two grants, not one signed twice: the approver signs A→B, and the
new machine signs B→A itself on finding it. Neither machine can speak for the
other before it has agreed to. `link list` shows which halves exist — a row
reading `outbound` was admitted by this machine and never answered, which is
what an approval nobody picked up looks like.

**Cutting a machine off:**

```bash
ll-search link revoke <key_id> --config-dir <config_dir>
```

It signs a revocation, lodges it with the hub, and then drops the local row —
in that order, because this store is this key's only record of what it issued,
and dropping the row first would leave nothing to sign a revocation *for*.

Two limits to state to the user rather than let them assume past:

- **It withdraws only the half this machine signed.** The grant the other
  machine issued to this one is that machine's statement about its own key;
  only that machine can withdraw it. `link revoke` says when one is still
  standing, and so should you.
- **It deletes nothing from disk.** A `link` is unscoped — "every vault this
  issuer owns" — so it names no directory under `federation/data/peers/` to
  remove. What stops the data being served is the hub dropping those vaults
  from this key's listing on the next sync, not the revocation.

There is no equivalent for a `follow` a peer holds on this vault. Nothing here
sends one; those lapse at their own expiry.

## G: Recovering an identity

The 24 words from step C restore this machine's key:

```bash
ll-search recover "<24 words>" --config-dir <config_dir>
```

Recovering the identity already on this machine needs nothing extra — nothing
is replaced, so there is nothing to authorise. Recovering a **different**
identity over an existing one requires `--force`, and the guard is the loss,
not the write: every grant naming the old key stays signed, valid, and
unreachable, while the machine still looks enrolled.

`recover` writes the seed and deliberately leaves `config.json` alone — the
hub pin and `vault_id` in it describe an enrollment the new key was never part
of. `ll-search status` prints a `RECOVERED` line when the two disagree.

## H: Where the seed lives, and repairing it

The identity is an Ed25519 seed held by the binary's seed store. Backends, in
priority order: the OS keyring (macOS Keychain, Linux Secret Service, Windows
Credential Manager), then a file encrypted at rest under
`<config_dir>/federation/` for machines where no keyring daemon runs. A
plaintext `.seed` file is a pre-v1.18 format — still readable as a migration
source, never written by the binary. On a fresh install no `.seed` exists, and
that is normal.

```bash
ll-search identity --config-dir <config_dir>
```

reports `pubkey_b64`, `backend` (`keyring`, `encrypted`, or
`plaintext-legacy`), and `created`. It is idempotent: an existing seed is
reused, so re-runs return the same key.

If `backend` is `plaintext-legacy`, offer to move it into a secure backend:

```bash
ll-search migrate-seed --config-dir <config_dir>
```

Fail-closed: the plaintext file is deleted only after the new backend has been
written and verified, and re-running against a migrated seed is a no-op.
`--rollback` reverses it. Never move a seed between backends by copying files
by hand.

**Very old installs** may have a plaintext seed at
`${CLAUDE_PLUGIN_ROOT}/federation/.seed` — a location wiped on reinstall. Copy
it to `<config_dir>/federation/.seed` (mode 0600) so the legacy reader and
`migrate-seed` can find it, delete the marketplace-directory copy, then run
`migrate-seed`. This is the only manual file move in this skill.

## Rules

- Never write or edit `config.json` before `join` has succeeded. A failed run
  must leave no state on disk.
- Never echo, store, or log the 24-word recovery phrase.
- The seed is the user's identity. Never delete it from its store — keyring
  entry or encrypted file — without an explicit request.
- The hub's key must be pinned. An unpinned hub is an error, not a warning:
  `ll-search sync` refuses the config and `ll-search status` says `BLOCKED`.
- One vault, one config dir. Never point two vaults at the same one.
- Anything that writes `config.json` — `join`, `link request` — is followed by
  `ll-watch stop && ll-watch`. A running daemon holds the old copy and will
  keep reporting against it.
