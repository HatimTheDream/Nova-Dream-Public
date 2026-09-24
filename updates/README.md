# Stable update channel

This directory publishes signed metadata for reviewed Nova Dream host updates. It is separate from GitHub source releases. `release-public.pem` is the public Ed25519 verification key; private signing material is never included in the repository or installed on a workspace host.

The fixed feed is `https://raw.githubusercontent.com/HatimTheDream/Nova-Dream-Public/main/updates/stable.json`. Initial metadata identifies a verified installed pair; it does not invent an installable predecessor or advertise an untested engine upgrade. A later installable release must bind its actual source candidate, target candidate, reviewed recovery procedure and signed bundle.

Before publishing, complete the application release gates and the host qualification described in [Software Update host setup](../docs/SOFTWARE-UPDATE-HOST.md) and the [reviewed installer procedure](../deploy/update-runner/README.md). Sign the exact reviewed metadata using `scripts/update-manifest.mjs` and a separately protected key. Retain the prior signed feed; sequence numbers must increase even when only the expiry or notes change.

Signed metadata expires. Publish a fresh reviewed signature before expiry, including during periods without an application release. An expired or unreachable feed reports unavailable status; it must not claim the host is up to date. Never replace a verification key without an explicit trust-migration procedure.

No workspace content, host address, account identity, recovery snapshot, private operational record or signing secret belongs here.
