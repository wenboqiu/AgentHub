# AgentHub

[中文](README.md) | English

AgentHub is a workbench for keeping tabs on many AI coding sessions at once: a desktop app (Tauri 2, Windows / macOS), an Android app, and a self-hosted hub service (Node + Fastify + Postgres with real-time WebSocket push). Detailed docs are kept in the [Chinese README](README.md).

## Features

- **Multi-agent session monitoring**: one page shows the live state of every Claude Code / Codex / ZCode / CodeBuddy / WorkBuddy / Doubao session. Whenever a session finishes or waits for approval, both the desktop tray and your Android phone notify you; one click jumps back to the right window, and handled alerts clear automatically or manually.
- **Remote control from your phone**: read the conversation, send follow-up messages, approve or deny tool permissions, or stop a run mid-flight — right from the Android app. Sessions waiting for approval are flagged and pushed.
- **Goals & tasks**: plain todos and agent tasks in one place, with checklists, start/due reminders, and session links; everything syncs across devices with your account.
- **Dispatching work**: hand tasks to Claude / Codex / ZCode / CodeBuddy through roles (tool, model, context, allowed tools); an in-app assistant can turn one sentence into a role draft for you to confirm.
- **Per-reply actions**: copy, rate, read aloud, or branch a new chat from any reply; ratings sync across devices.
- **Machines page**: settings show every computer as online / remote-exec disabled / offline, with the dispatch-capable tools each one reports.

## Screenshots

| Desktop · session overview (pending / running bubbles grouped by project) |
|---|
| ![Desktop session overview](docs/screenshots/desktop-sessions-graph.png) |
| **Desktop · session detail: approve permissions in-app; copy / rate / read aloud / branch any reply** |
| ![Desktop session detail](docs/screenshots/desktop-session-detail.png) |
| **Android · remote control: read the chat and approve (allow / deny)** |
| ![Android approval](docs/screenshots/mobile-session-approval.png) |

> Screenshots show the current UI rendered with fake data (local preview harness + headless browser); no real projects or sessions included.

Current version **v0.17.0**. Release notes live one file per version in `docs/releases/` (Chinese): [0.17.0](docs/releases/0.17.0.md), [0.16.0](docs/releases/0.16.0.md), [0.15.3](docs/releases/0.15.3.md)… newest first, each with upgrade and verification notes.

## Development

See the [Chinese README](README.md) for the full development guide. In short:

```bash
# Hub service (needs Postgres, e.g. docker run -d --name agenthub-pg \
#   -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=agenthub -p 55433:5432 postgres:16-alpine)
cd server && npm install && npm run check && npm test
ADMIN_TOKEN=devadmin DATABASE_URL=postgres://postgres:dev@localhost:55433/agenthub node src/index.ts
# open http://127.0.0.1:3000/admin, create an account with devadmin, then log in from the app

# Desktop app (Tauri 2)
npm install
npm run tauri dev          # point it at http://127.0.0.1:3000 and the account above
npm run tauri build
```
