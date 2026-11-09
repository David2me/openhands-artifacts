# Artifacts (OpenHands App)

Adds an **Artifacts** item to the Agent Canvas sidebar, directly under **Automate**. The page lists every file your conversations uploaded, created, edited, wrote with a command, showed as an image, or mentioned, in order of first appearance.

- Entrypoint: `extension.js` (one self-contained browser ESM file, no build step, no dependencies)
- Manifest: `canvas-extension.json` (schema 1, host API 1, one page at `/extensions/artifacts/artifacts`)

## Install

In Agent Canvas open **Customize -> Apps -> Add app** and use one of:

- Git source: `github:David2me/openhands-artifacts` (no `repo_path` needed; the app is at the repo root).
- Backend-local path: the absolute path of this folder as the Agent Server sees it (inside the container, not a Windows path).

Installing leaves the app disabled. Enable it and accept the trusted-code prompt. The sidebar entry appears immediately, no restart needed.

After changing `extension.js`, uninstall and reinstall the app (the Apps screen has no refresh action).

## Using the page

| Action | How |
|---|---|
| Download | Right-click -> Download, or select a row and press Enter |
| Preview | Double-click, or right-click -> Preview in new tab (unknown binary types download instead) |
| Copy path | Right-click -> Copy container path |
| Jump to conversation | Click the conversation name |
| Filter | Search box, kind badges, Group by conversation, Hide missing files |

"Where it is": files under `/projects` are synced to your PC; **Container only** files exist only inside the sandbox, so download them before cleaning it up. The page refreshes every minute while the tab is visible.

## How it works

Everything goes through `host.agentServer.request`, so it uses the active Agent Server and Canvas authentication:

- `GET /api/conversations/search` and `/api/conversations/{id}/events/search` to read conversation events.
- `POST /api/bash/execute_bash_command` to check which files still exist and to read file bytes (base64 in chunks).

File detection is the same as the standalone tool: `NEW FILES ADDED:` notes, file editor create/edit, write/edit tools, shell redirections, `cp`/`mv`/`zip`/`tar`/`curl -o` targets, screenshots, and paths mentioned in agent messages.

The scan cache lives in the browser's `localStorage`, keyed by backend. Preview opens text-like files as plain text (never as HTML) so a file cannot run script inside Canvas.

## Differences from the standalone helper

A browser App cannot touch your PC, so these are gone: Open file location in Explorer, opening with the default app, Copy Windows path, saving copies to `_artifacts\`, and the `.cmd` launcher. Download and in-browser preview replace them.
