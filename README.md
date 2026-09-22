# Game Vault

Game Vault is a browser-based game publishing and project management platform. It combines a public game catalogue, version-aware project management, community features, and a Theia-powered development studio in one workspace.

## Highlights

- Exact-version game browsing, preview, editing, and downloads
- Markdown game descriptions with rich formatting
- User accounts, profiles, favourites, comments, and community ratings
- Version management with synchronized metadata
- Admin dashboard for projects, versions, comments, activity, and publishing
- Theia Studio integration with file navigation, project tools, previews, and version controls
- AI project assistant with streamed responses, sessions, attachments, Skills, file diffs, and explicit approvals
- Light and dark themes with responsive desktop and mobile layouts
- Local build job storage, queue processing, and archive output generation

## Architecture

Game Vault uses a Node.js application server as the integration point for the public dashboard, authentication, project files, community data, AI services, and Theia Studio.

```text
Browser
  ├─ Public catalogue and user dashboard
  └─ Theia Studio
       │
       └─ /gv-api proxy
            │
            └─ Game Vault Node.js server
                 ├─ Authentication and sessions
                 ├─ Game and version catalogues
                 ├─ Community and activity data
                 ├─ AI agent and Skill instructions
                 └─ Build jobs and project operations
```

The dashboard runs on port `8080`. Theia Studio runs on port `3010` and is opened through the dashboard so its API requests use the correct authenticated proxy.

## Requirements

- Node.js 24 or newer
- npm 10 or newer
- Git
- Windows, macOS, or Linux

Runtime secrets belong in local environment files. Do not commit `.env`, `.ENV`, tokens, or generated private storage.

## Run locally

From the repository root:

```powershell
npm.cmd install
npm.cmd start
```

Open `http://localhost:8080` and open Studio from the dashboard. The server starts Theia when Studio is opened; port `3010` is not the main application entry point.

If PowerShell blocks `npm`, use `npm.cmd` as shown above instead of changing the machine-wide execution policy.

## Build Theia Studio

Rebuild Theia after changing Studio extensions, themes, or frontend/backend contributions:

```powershell
cd theia
npm.cmd install
npm.cmd run build
cd ..
npm.cmd start
```

The local `game-vault-theia-extension` package registers the Game Vault `/gv-api` proxy and Studio modules in generated builds.

## Test

Run the repository checks from the root:

```powershell
npm.cmd test
```

Useful focused checks include:

```powershell
node tests/studio-proxy.test.js
node tests/build-store.test.js
node tests/build-tools.test.js
node tests/build-queue.test.js
node tests/build-runner.test.js
```

## Repository layout

```text
backend/                 Node.js services and domain modules
  ai/                    Agent, sessions, tools, and streaming
  auth/                  Accounts, sessions, and Studio access
  builds/                Build storage, tool checks, queue, and runner
  community/             Comments, ratings, and activity
  http/                  Responses, static serving, and Studio proxy
  projects/              Game catalogue, metadata, history, and paths
frontend/                Public dashboard and management UI
games/                   Game projects and versioned files
scripts/                 Startup checks and local tooling
skills/                  Project Skill definitions used by the AI assistant
tests/                   Contract, integration, and behavior tests
theia/                   Theia application and Game Vault Studio extension
```

## AI Skills

Skills are versioned project instructions used by the Studio assistant:

- `bug-fix` — investigate the root cause and prepare a reviewable diff
- `code-review` — review project quality, bugs, and security concerns
- `metadata-auditor` — validate `game.json` and `README.md`

Skills are selected from the AI panel in Studio. The selected instruction file is included in the assistant context, while every file and command change remains reviewable before application.

## Security principles

- Project paths are validated before file access.
- `.env` files and private storage are excluded from Git.
- AI file edits and terminal commands require explicit review.
- Build artifacts are stored per game, version, and job ID.
- The Studio proxy forwards only `/api/*` requests to the dashboard service.
- Versioned workspaces remain separate so edits target the selected version.

## Development status

Game Vault is under active development. The legacy Node.js dashboard and Theia Studio are the primary local development path. The repository also contains the foundation of a newer service-oriented architecture that is being migrated incrementally.

## License

This project is private and is not currently distributed under a public open-source license.
