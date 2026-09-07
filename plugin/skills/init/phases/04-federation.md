# Phase 4: Federation (Optional)

Federation lets you share vault notes with other learning-loop users through a hub. Setup spans an Ed25519 identity, a hub whose key must be pinned and confirmed out-of-band, a 24-word recovery phrase shown once, and visibility rules — so init only asks the question and hands off to a dedicated skill.

## Detect

If `PLUGIN_DATA/vaults.json` or `PLUGIN_DATA/federation/config.json` exists from a previous setup, skip with: "Federation: already configured. Run `ll-search status --config-dir <PLUGIN_DATA>` for detail."

## Ask

Otherwise, ask:

> Set up federation now? It connects this vault to other learning-loop users through a hub. You will need either an invite code — any existing member of that hub can get you one — or a machine already enrolled that can link this one. (default: no)

If the user says **no** or just confirms the default, skip silently. Federation is opt-in and most users do not need it on first install.

If the user says **yes**, hand off:

```
Run /learning-loop:federation. The full setup is there: enrolling this vault on
a hub, the recovery phrase, visibility rules, and linking a second machine.

Have the hub's endpoint and its six-word fingerprint ready — you confirm those
words out-of-band before anything is sent.
```

Do NOT execute federation setup from inside /init. The federation skill handles its own detect-confirm-apply loop and is safe to run independently.
