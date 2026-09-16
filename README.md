# Nova Dream

![Version](https://img.shields.io/badge/Version-1.1.3-blue)

A self-hosted, single-owner workspace for your Assistant, agents and everyday work.

Nova brings together a customizable Home board, Tasks and Projects, Google/Microsoft Calendar and Inbox, Contacts, a writing workspace, Profile quests and XP, voice conversations, and a modular pixel-art agent office.

This repository contains the application source and synthetic tests. It starts with an empty workspace. You use your own accounts, credentials and hosting; no maintainer account, production database, conversation history or live deployment is included. A public source repository does not make anyone's private workspace public.

## Quick start

Requires **Node.js 22.19 or newer** and npm. Node 22.23.2 is the reference runtime.

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4383/**. Local development uses `npm run dev` and **http://127.0.0.1:4384/**. The backend stays on loopback. Avoid running both production and development on the same service port.

The default workspace is stored in `.data`, outside Git. Back it up before changing builds. The app verifies built client/service hashes before startup. An existing running instance is not automatically upgraded just because a new build exists.

## Connect your services

- **Assistant, agents and voice:** configure your own OpenClaw/ChatGPT connection in Settings. The supported native reference is OpenClaw 2026.9.2. Connected AI subscriptions, API availability and usage limits belong to their providers. Voice needs browser microphone permission and a supported realtime connection.
- **Google and Microsoft:** register your own OAuth application and use the callback shown in Settings. Choose the scopes you need; server hosting requires a Web callback and server-side client credentials. No shared developer credentials are shipped.
- **Agents:** create your own team and explicitly select their workspace access. Native computer control requires a compatible, permissioned local connection; a VPS cannot operate a powered-off personal computer.
- **Remote browser access:** follow [the Linux host recipe](deploy/README.md) and [protected Vercel gateway recipe](deploy/vercel/README.md). Keep authentication in front of the app. This is a single-owner application, not a public multi-tenant service.

## What is included

- Revisioned Tasks, Projects, recurrence, checklists, history, Trash and recovery-aware editing.
- Assistant conversations, files, captured-source reading, outputs, queues, tools and background assignments.
- Voice captions, mute and end, using your configured connection.
- Mail/calendar workflows with explicit confirmations and preserved uncertain outcomes.
- Content drafts, reviews, revisions, collections, templates and exports.
- Shared character appearance, agent offices, collaboration space, quests and progression.
- Encrypted backup creation, review and restoration into a separate paused workspace.

## Backups and privacy

Use **Settings → Data & recovery** to create an encrypted export and keep its password outside the host. Backups include their own coverage summary; browser-only unsaved drafts, external Work directories and separately hosted histories may require separate copies. Recovery creates a new copy with connected execution paused for review. Reconnect your accounts through their supported sign-in flows.

Keep data directories, environment files, encryption keys, cloud credentials and downloaded backups out of Git. Automatic independent off-server backup scheduling is not included in this release. See [security reporting and deployment boundaries](SECURITY.md).

## Development and verification

```sh
npm run typecheck
npm test
npm run quality
```

The coherent quality gate includes type checking, tests, production dependency audits, release metadata validation and the client/service build. CI runs the same gate. Internal package identifiers retain the Edition 3 name for compatibility; `private: true` prevents accidental npm package publication. Source distribution is separate from signed desktop installers, which are not provided here.

The accepted pixel character and current runtime assets are included. Unused experimental 3D models, downloaded generation outputs, private design records and authoring environments are excluded. See [third-party notices](THIRD_PARTY_NOTICES.md) and [the changelog](CHANGELOG.md).

## License

MIT; see [LICENSE](LICENSE). Original third-party copyright and license notices are retained. Dependencies keep their respective licenses. Bundled original/generated artwork is provided under the project license to the extent the contributors hold applicable rights; no exclusivity or trademark rights are promised.
