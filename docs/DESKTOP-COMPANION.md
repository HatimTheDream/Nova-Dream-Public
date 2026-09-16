# Installation and optional desktop access

**Desktop preview status:** a packaged Mac companion completed a local Calculator test, verified every input and the result, then disconnected and shut down its helper. Hosted sign-in also opened the existing workspace. Full-desktop and remembered-access options have automated coverage; their actual broad grant is not enabled by these checks. No public installer is published.

Nova supports a local workspace and an optionally hosted workspace. **A VPS is not required.** The desktop companion connects to an existing workspace; it does not start another backend or copy its accounts.

| Setup | Workspace runs on | Needs a personal computer online? |
| --- | --- | --- |
| Local Nova | Your computer, using the repository's normal start/launch commands | Yes, while using that host |
| Hosted Nova | Your chosen always-on host; a VPS is one option | No, for host work |
| Optional computer control | An explicitly linked desktop with selected-app or full-desktop access enabled | Yes, for that computer's actions |

Phone and browser clients connect to the chosen workspace host. Work on that host does not depend on a desktop link. Native computer control requires an awake linked computer, its running companion, and locally enabled access. This is not direct phone control. Repository access, provider accounts and host browser availability still require their own configuration.

## Install on a phone or in a browser

Settings → **Devices** shows the installation instructions for the current browser. Where supported, the Install button opens the browser's native installation prompt. iPhone users use Safari's Share → Add to Home Screen. Nova's icon is included.

The page reports actual site storage and can request persistent browser storage. Existing unsent writing and pending uploads stay in Nova's existing device journals. Installation does not create a complete offline copy of the workspace or make connected AI/mail available offline. Clearing site data can remove unsent drafts.

## Build the desktop companion locally

The current packaging recipe supports **Apple Silicon Macs**. Windows/Linux installers and their native-driver setup are not available in this release.

1. Install the repository's dependencies and build the application normally.
2. Run `npm run package:companion` from the application directory.
3. Open the generated `Nova Dream Desktop.app` inside `.packages/companion/<version>-<candidate>/`.
4. Enter your existing Nova address: an HTTPS hosted address or `http://127.0.0.1:<port>` for a locally running workspace.
5. Sign in to that workspace normally. In Nova, use Settings → Devices → Link this desktop.
6. Open Desktop controls and choose **Selected apps** or **Full desktop access**. Select 15, 30 or 60 minutes, or **Until I turn it off**, then review the native confirmation.

Full desktop access can observe and operate all applications and the visible desktop, including logged-in services and files reachable through their interfaces. Protected macOS authentication still requires the person using the computer. This is desktop interaction, not a separate remote shell or unrestricted filesystem API.

**Until I turn it off** remembers the explicitly approved choice in OS-encrypted storage. It resumes after restarting the companion and authenticating the same workspace/device link. There is no periodic renewal prompt. The computer must remain awake and the companion running. Quitting stops the helper; reopening resumes a remembered grant. **Stop computer access**, **Disconnect and forget**, or remote **Revoke link** clears remembered authority. A menu-bar indicator and Stop control remain available while the main window is hidden.

The package downloads a pinned official Electron archive and checks its SHA-256. Only the companion code, branding and runtime are packaged. Workspace data, AI credentials, the Nova backend and CuaDriver are not included. The package is locally ad-hoc signed and is **not notarized**. Public binary distribution requires a separate Developer ID signing/notarization release; do not publish this archive as a public installer.

Computer access currently requires the separately installed compatible `cua-driver` helper at `~/.local/bin/cua-driver`, plus its macOS Accessibility and Screen Recording permissions. Use that helper's supported installation and permission flows. Nova does not silently install or grant OS permissions. Selected-app access retains an explicit app manifest and disables whole-desktop capture. Remembered grants use the driver's standard profile without a lifetime; full desktop uses standard desktop authority and Nova's fixed GUI tool interface. Nova does not select the driver's approval-bypass mode. OS and managed policies remain in force. See the upstream [permission manifest](https://cua.ai/docs/how-to-guides/driver/write-a-bounded-manifest) and [permission profile contract](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/Skills/cua-driver/SKILL.md#keep-authorization-separate-from-sessions).

## Host a private download

The packaging output includes `downloads.json` and a versioned ZIP. Put these two files in a host-owned directory and set `E3_COMPANION_DOWNLOADS` to that absolute directory before starting Nova. With no setting, Nova remains fully usable and reports that no download is configured.

The download catalog and chunks require the workspace's existing authentication. Nova checks each 2 MB chunk and the final archive digest before saving the ZIP, including through hosts with response-size limits. No arbitrary host files are downloadable through this route. Keep the directory outside user-uploaded workspace files and preserve old packages until their replacement is verified.

## Remote work and stopping access

An agent needs the **Computer** workspace capability in both its captured and current design. Existing agents gain no new access automatically. Main Assistant and agent computer requests create review cards. Approve the requested action through Nova on your signed-in phone or browser, then check its actual result before continuing. The desktop link supplies its live tool schemas; an offline computer is never silently substituted with another device.

Each link has an OS-encrypted private key. Only its public key is registered with the workspace. Requests bind a particular workspace, computer and original operation. Interrupted actions retain receipts: an uncertain click is not automatically repeated. Results are available in their original conversation. Restarting or restoring a workspace never resumes queued computer actions, and a restored backup does not revive old desktop links.

Use **Stop computer access** to end the local grant, **Disconnect and forget this link** to remove local connection credentials, or **Revoke link** in Nova to reject future packets from that desktop. Actions already performed cannot be undone by disconnecting. After quitting, no companion dispatcher should remain running.
