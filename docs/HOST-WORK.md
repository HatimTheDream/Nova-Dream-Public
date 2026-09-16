# GitHub work, teams and host browsing

A VPS is optional. Nova can run on your computer or a server. These tools execute
on that host, using the same workspace from desktop or phone. A local host must
remain online; an always-on server can continue while your personal computer is
off. Desktop app control still requires a linked, awake desktop.

## What needs to stay online?

The host is the computer or server running Nova's service. Opening Nova on a
phone or installing its desktop companion does not move that service or its
repository checkouts to the viewing device.

| Action | Required connection |
| --- | --- |
| Chat with Assistant | A reachable Nova host and its configured AI connection |
| Edit a GitHub project or run a team | The host with that checkout and the configured AI connection |
| Push a branch or open a draft pull request | The host and its connected GitHub account |
| Browse a public website | The host with Chrome or Chromium and Host browser enabled |
| Control a desktop app | A linked, online desktop with the companion running and access enabled |

With Nova hosted on a server, the first four actions work while your personal
computer is off. With Nova hosted locally, that computer needs to stay online.
A desktop linked for computer control is a separate requirement; it does not
replace the host. Reading and saving your workspace require a reachable host,
but do not require an AI connection. A VPS remains optional.

## GitHub

Install Git and [GitHub CLI](https://cli.github.com/) on the host. In Settings →
Accounts, connect GitHub using its device code and review GitHub's requested
permissions. Nova uses a temporary isolated CLI profile and encrypts the resulting
credential in its workspace. It does not import your existing terminal login.
The connection remains until revoked, disconnected or expired by GitHub.

In Assistant → Work, choose **Open repository**, select the repository and base
branch, and prepare it on the host. Nova creates a separate `nova/…` feature
branch. Save the Work Project and start a conversation. Local folders are also
supported; built-in publishing is limited to checkouts created by this picker.

In the Work changes panel, expand **Publish changes**. Review the files and add
a title. Commit the reviewed tree, push the branch, then open a draft pull request.
Each is an explicit action. Publication waits for coding to finish. Refreshed
file contents require another review; a push never force-updates a branch.
Merging, release packaging and deployment remain separate actions.

If a response is interrupted, check the saved original request or publication
receipt. Nova checks the actual Git branch or GitHub result instead of repeating
an unconfirmed effect. Code stays on the host when the phone disconnects.

## Team work

Create at least two agents in Agents. In Work → **Team work**, select a local
Work Project and choose members for research, implementation and review. The
stages run sequentially in one checkout. Each receives the saved previous
handoffs and its captured agent instructions. Implementation can edit files;
research and review use read-only sessions. App tools also require both the
captured and current agent capability. The hub links to each current conversation.

**Pause after stage** lets the current stage finish and prevents another from
starting. **Stop team** cancels the original current run and retains its changes.
A host restart pauses the sequence for review. Unknown results block the next
stage until reconciled. A failed or cancelled stage can be explicitly skipped.
Review the final changes and checks before publishing. A completed workflow does
not by itself certify that the implementation has no defects.

## Host browser

Install Chrome or Chromium on the host and start Nova's managed Assistant. In
Work → **Host browser**, enable it and open a public website. Inspect real page
text and screenshots there, or ask Nova to browse through the workspace tools.
For agent assignments, select Browser access in the agent's capabilities.
Browser actions use review cards and fresh observations; an interrupted action
is not automatically repeated. Browser tabs use a dedicated profile, separate
from the user's browser. Turning it off closes its network route.

The browser uses a loopback proxy that resolves and pins public IPv4 destinations
on ports 80 and 443. Private, loopback, link-local, reserved and IPv6-only
destinations are unavailable in this version. HTTPS is tunneled unchanged and
certificate checks remain in Chromium. Redirects, subresources and service-worker
traffic use the same proxy. Direct UDP/QUIC and non-proxied WebRTC are disabled.
The runtime's browser hostname guard is delegated to this proxy because its
strict mode cannot enforce hostname navigation through a proxy. Native browser
tools are denied so Nova's reviewed browser operations remain the app entry point.
This is a network boundary, not a filesystem sandbox for arbitrary host code.

Browser sign-ins, websites' own prompts and provider limits still apply. This
feature does not add an AI subscription or a paid browser service.
