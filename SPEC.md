# The Enterprise — Layer 1: Chat Interface with Daemon Heartbeat

## What We're Building

A chat UI that communicates with a local OpenClaw/Claude Code daemon via a message queue. The UI doesn't call LLM APIs directly — it writes messages to a queue, and the daemon (running on Claude Max) picks them up via heartbeat polling, processes them (including MCP x402 tool calls), and writes responses back.

## Architecture

```
┌─────────────────┐        SQLite/file         ┌──────────────────┐
│   React UI      │ ───── message queue ──────► │  OpenClaw Daemon │
│  (Vite + React) │ ◄──── response queue ────── │  (Claude Code    │
│                 │                              │   on Max plan)   │
└─────────────────┘                              └──────────────────┘
     Port 4111                                    Heartbeat polling
```

## Message Queue (SQLite)

Database: `~/.enterprise/messages.db`

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,           -- uuid
  thread_id TEXT NOT NULL,       -- conversation thread
  role TEXT NOT NULL,            -- 'user' | 'assistant' | 'system' | 'tool'
  content TEXT NOT NULL,         -- message content
  status TEXT DEFAULT 'pending', -- 'pending' | 'processing' | 'complete' | 'error'
  metadata TEXT,                 -- JSON: tool calls, cost, latency, etc.
  created_at INTEGER NOT NULL,   -- unix ms
  updated_at INTEGER NOT NULL    -- unix ms
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  title TEXT,
  soul TEXT,                     -- soul config name (future: Layer 4)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_messages_thread ON messages(thread_id, created_at);
CREATE INDEX idx_messages_status ON messages(status);
```

## UI (React + Vite)

Build as a new workspace in the mastra-arena monorepo: `enterprise/`

### Pages
1. **Chat** (`/`) — Thread list sidebar + message view + input. Similar to existing Mastra agent chat but writing to local SQLite instead of Mastra API.
2. **Threads** — List all threads, create new, delete.

### Key behaviors
- User types message → INSERT into messages (role='user', status='complete')
- UI polls for new assistant messages on active thread (every 500ms)
- Shows typing indicator when a message has status='processing'
- Renders markdown, code blocks, tool call results

### Tech
- React 19 + Vite
- TailwindCSS (reuse mastra playground-ui design system)
- better-sqlite3 (via a tiny local API server)
- Tanstack Query for polling

## Local API Server

Thin Express/Hono server (port 4111) that wraps SQLite:

```
GET    /api/threads              — list threads
POST   /api/threads              — create thread
GET    /api/threads/:id/messages — list messages for thread
POST   /api/threads/:id/messages — add user message (status='complete')
GET    /api/status               — daemon health (last heartbeat time, pending count)
```

No LLM calls. Just CRUD on the queue.

## Daemon (OpenClaw Heartbeat)

A script that the daemon runs on heartbeat or cron (every 5-10s):

```bash
# enterprise/daemon/poll.mjs
# 1. Query: SELECT * FROM messages WHERE status='pending' AND role='user' ORDER BY created_at LIMIT 1
# 2. UPDATE status='processing'
# 3. Gather thread context (previous messages in thread)
# 4. Call Claude Code CLI: claude --print -p "<context + message>"
# 5. INSERT response (role='assistant', status='complete')
# 6. UPDATE original message status='complete'
```

For MCP x402 tools: Claude Code already supports MCP. The daemon just needs the right MCP config.

## File Structure

```
enterprise/
├── SPEC.md              (this file)
├── package.json
├── vite.config.ts
├── tailwind.config.ts
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── pages/
│   │   └── Chat.tsx
│   ├── components/
│   │   ├── ThreadList.tsx
│   │   ├── MessageView.tsx
│   │   ├── MessageInput.tsx
│   │   └── TypingIndicator.tsx
│   ├── hooks/
│   │   ├── useThreads.ts
│   │   ├── useMessages.ts
│   │   └── useStatus.ts
│   └── lib/
│       └── api.ts
├── server/
│   ├── index.ts         (Hono API server)
│   └── db.ts            (SQLite setup + queries)
└── daemon/
    └── poll.mjs         (heartbeat script)
```

## MVP Scope

- [x] Spec
- [ ] SQLite schema + server CRUD
- [ ] React chat UI (single page, thread sidebar, message view)
- [ ] Daemon poll script
- [ ] Wire it together: type message → daemon processes → response appears

## NOT in Layer 1
- Dashboards (Layer 2)
- Memory compaction (Layer 3)
- Soul loader (Layer 4)
- Season recording (Layer 5)
- BYOK for non-Claude providers
- Streaming (poll-based first, upgrade later)
