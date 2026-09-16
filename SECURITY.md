# Security and private deployment

Nova Dream is a single-owner application. Local listeners bind to loopback. Remote use needs the configured authenticated Tailscale or protected Vercel entry and HTTPS; never expose the raw backend or trust identity headers from an arbitrary public proxy.

Use separate protected server and gateway credentials, outside the application directory. Keep an independent recovery copy of the encryption credential and backup password. Account connections and tool access require explicit setup; connecting an account does not authorize every possible external action.

Do not post credentials, databases, personal conversations or raw provider logs in public issues. For suspected vulnerabilities, use GitHub's private vulnerability reporting when enabled. If it is unavailable, open a minimal issue requesting a private contact without revealing exploit details or personal data.

This source release is not a multi-user access-control system or a signed desktop installer. The optional computer companion and automatic independent backup scheduling remain separate work. Backup and restore tests must use a separate copy before changing a live workspace.
