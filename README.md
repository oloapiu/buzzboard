# buzzboard

A Trello-style kanban board over a [buzz](https://github.com/block/buzz) relay,
with agent dispatch. Repos are swimlanes, NIP-34 issues are cards, and
assigning a card to an agent posts the mention message that wakes it via
buzz-acp.

**Prototype.** FastAPI + HTMX + Alpine + Tailwind + SortableJS. Requires no
changes to the relay — everything rides on event kinds buzz already accepts.

## Run

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/selftest.py          # verify crypto without a relay
.venv/bin/uvicorn app.main:app --reload --port 8400
```

Open http://localhost:8400, then in **Settings**:

1. Relay URL (`wss://…` or `https://…`) and your private key (nsec or hex).
   The key is stored in `data/board.db` so the server can sign — use a
   throwaway/agent key, not your main identity.
2. Optionally pick a **dispatch channel** — assignment messages are posted
   there (the assigned agent must be a member to receive mentions).
3. Optionally create a placeholder repo (e.g. `misc`) to hold tickets that
   belong to no codebase. Repo announcements are just events; no git content
   is needed and an empty repo is fully supported by the relay.

## How it maps to the protocol

| Board concept | On the wire |
|---|---|
| Swimlane | kind 30617 repo announcement (`d` = repo id) |
| Card | kind 1621 git issue (`a` = `30617:<owner>:<repo>`, `subject`, `t` labels) |
| Column: Triage | kind 1633 (draft) status event |
| Column: Backlog | kind 1630 (open) status event |
| Column: In Progress / In Review | kind 1630 + `t` label `in-progress` / `in-review` — see below |
| Column: Done | kind 1631 (resolved) |
| Column: Closed | kind 1632 (closed) |
| Assign + dispatch | kind 9 channel message with `["p", <agent>]` (wakes buzz-acp) |
| Card order, assignee display | **board-local SQLite** (`data/board.db`) — not on the relay |

Reads and writes use the relay's HTTP bridge (`POST /query`, `POST /events`)
with per-request NIP-98 auth, exactly like `buzz-cli`. The board polls every
5 s (paused while dragging or while a modal is open).

### Status derivation

Ported from buzz desktop (`projectIssues.mjs`): status events signed by the
**issue author or repo owner** count; latest wins. Kind decides first
(1631 → Done, 1632 → Closed, 1633 → Triage), then label heuristics, else
Backlog.

Board extension — the **card's assignee** (from local meta) is also an
allowed actor, with agent-lifecycle semantics, because the buzz CLI can only
express open/resolved/closed/draft: assignee `open` → **In Progress**
(claimed), assignee `resolved` → **In Review** (awaiting human sign-off —
only the author/owner's `resolved` means Done), assignee `draft` → Triage
(blocked).

One deliberate extension: labels on the **latest status event** are honored
before the issue's own labels. NIP-34 has no In Progress/In Review status
kind — the desktop derives those from immutable issue labels, which can't
express *moving* a card. Publishing `1630 + t:in-progress` keeps every event
valid NIP-34; the buzz desktop will just coarsely show such cards as Backlog
until it learns the convention.

### Known limitations (prototype)

- **Moves only stick if you're the issue author or repo owner** (that's the
  desktop's authorization rule; using your own placeholder repo you're always
  the owner).
- **Rank + assignee are per-board**, not shared: the relay rejects
  unregistered event kinds, so there's nowhere protocol-side to put them yet.
  The clean fix is a small upstream PR adding an addressable card kind.
- Issue title/body are immutable after creation (NIP-34 has no issue edit).
- Single identity per board instance; the key is stored in local SQLite.
- Dragging between swimlanes is disabled — an issue's repo (`a` tag) is
  immutable.
