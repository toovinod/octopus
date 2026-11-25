# web

The Octopus user interface, a Next.js static export that the desktop app loads from disk.

In the desktop app it reaches the daemon through Tauri.
In a plain browser, set `NEXT_PUBLIC_OCTOPUS_DAEMON_URL` to the daemon's WebSocket URL, for example a dev daemon whose sessions replay recorded turns:

```bash
OCTOPUS_DATA_DIR="$(mktemp -d)" bun run --cwd apps/daemon dev:replay
```

It listens on port 4799, makes a fresh token on every start and prints the command that starts the web app against it, such as:

```bash
NEXT_PUBLIC_OCTOPUS_DAEMON_URL="ws://127.0.0.1:4799/rpc?token=<printed token>" bun run --cwd apps/web dev
```

Open the app at `http://localhost:3000`: the daemon refuses pages from any other origin.
Set `OCTOPUS_DAEMON_DEV_ORIGIN` to serve it from somewhere else.
Stop the daemon with Ctrl+C.

UI components come from shadcn/ui in `packages/ui`.
Add one with `bunx --bun shadcn@latest add <name>` from `packages/ui`, then replace its `from "cn"` import with `@repo/ui/lib/utils`.
