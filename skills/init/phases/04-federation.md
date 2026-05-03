# Phase 4: Federation (Optional)

Federation lets you share vault notes with other learning-loop users via interchange.live. Setup is non-trivial (Tailscale, Ed25519 keypair, single-use tokens, hub sync round-trip), so init only asks the question and hands off to a dedicated skill.

## Detect

If `PLUGIN_DATA/federation/config.json` exists from a previous setup, skip with: "Federation: configured, [N] peer(s)."

## Ask

Otherwise, ask:

> Set up federation now? Federation connects you to other learning-loop users via interchange.live. You will need an invite token from robin. (default: no)

If the user says **no** or just confirms the default, skip silently. Federation is opt-in and most users do not need it on first install.

If the user says **yes**, hand off:

```
Run /learning-loop:federation when you have a token. The full setup is there:
identity creation, token redemption, Tailscale, visibility rules, sync test.

Apply for a token at https://interchange.live/apply if you do not have one.
```

Do NOT execute federation setup from inside /init. The federation skill handles its own detect-confirm-apply loop and is safe to run independently.
