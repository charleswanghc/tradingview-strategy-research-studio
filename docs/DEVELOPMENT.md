# Development and releases

This repository has its own Git history and contains only the local research
product. The original extension UI, sample projects and private user workspaces
are not part of this source tree.

| Directory | Responsibility |
| --- | --- |
| `desktop` | Electron window, isolated local service, single instance, shutdown |
| `backend` | HTTP panel, authenticated WebSocket bridge, MCP, batches, AI, reports |
| `extension` | Chrome connection settings, TradingView adapters, downloads |
| `shared` | TypeScript request/state contracts |
| `scripts` | Build, public-source audit, desktop packaging, fresh-release verification |
| `examples` | Newly authored generic public examples |

The desktop app selects available loopback ports and stores its own settings
under Electron's per-user application-data directory. Chrome pairing is explicit.
The backend and extension enumerate combinations and verify exports; the model
returns structured proposals with no browser tools. Each source version and run
has separate saved artifacts. Disconnected or stopped sessions are retained for
inspection, not automatically replayed.

## Build and test

```powershell
npm run bootstrap
npm run build
npm test
npm run audit:public
```

The backend tests use synthetic DOM/report fixtures and mock AI responses.
They cover authentication, pairing, interrupted sessions, compiler failures,
immutable files, cost/date/property checks, paired-trade counting, and bounded
multi-version parameter batches. Windows additionally checks DPAPI encryption
using a fake key. These tests do not replace acceptance with a real account.

## Windows release

On Windows x64 with Node.js 22.12+:

```powershell
npm run package:windows
npm run verify:release
```

Packaging copies only compiled backend, production dependencies, public docs,
generic examples and compiled bridge into a fresh `.app-build` directory. It
bundles Electron with a real EXE, includes matching source-tag metadata and
SHA-256 hashes, and exposes `TradingViewBridge` beside the EXE. Verification
extracts the ZIP, checks every hash/path, starts the packaged EXE without system
Node.js, and asserts no workspace, AI key or account connection is preloaded.

Review source and distribution audits before pushing a release. Generated
folders, user settings and credentials are ignored and must never be force-added.
Version 0.4.0 is the first release of this independent repository.

## Optional MCP mode

`node backend/dist/index.js --setup` creates local pairing and client snippets
under `backend/.local`. `node backend/dist/index.js` starts stdio MCP; the config
snippets provide the absolute executable/path for a local MCP client. MCP does
not automatically watch conversations or scrape a ChatGPT browser window.
Use either the standalone browser dashboard or stdio MCP on the default bridge
port. The desktop application uses its own selected ports and pairing file.

## Release acceptance

The clean desktop launch, bundled executable and automated fixture loops must
pass before publishing. Actual browser installation, account login, Pine
compilation, account eligibility and paid API calls remain user-account checks.
Mark this status clearly in the release notes instead of claiming a real loop
was tested when only fixtures were used.
