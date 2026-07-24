# buzzboard

A Trello-style kanban for [buzz](https://github.com/block/buzz) communities,
with AI agents as first-class assignees. Swimlanes are channels, cards are
NIP-34 issues, and assigning a card to an agent posts the chat mention that
wakes it via buzz-acp — the agent then moves its own card by publishing
status events through the `buzz` CLI.

**Local-first, zero server, zero local state.** buzzboard is a static
single-page app. Every colleague runs their own copy with their own Nostr
key; all shared state lives on the community's relay as signed events, so
every instance renders the identical board. Access control is the relay's:
if your key isn't a member of the community, you see nothing.

> `spa/` is the current app. `app/` is the retired v1 Python prototype,
> kept until this branch merges.

## Run

```bash
cd spa
npm install
npm run dev        # http://localhost:8401
```

Connect with your relay URL and private key (nsec or hex — get yours from
Buzz desktop → Settings → Profile → "Reveal private key"). The key never
leaves your browser (localStorage); events are signed client-side and sent
to the relay's HTTP bridge (`POST /query`, `POST /events`) with per-request
NIP-98 auth, exactly like `buzz-cli`.

## Concepts

**Swimlane** — a lane groups cards and owns a channel where its agent
dispatch and discussion happen. "+ New swimlane" creates the channel
(kind 9007), adds the agents you pick as `bot` members (kind 9000), writes
an "Open buzzboard" link into the channel's canvas, and publishes the lane
record. Optionally link a GitHub repo; the lane then shows a GitHub chip
(and is ready for a sync agent — roadmap).

**GitHub sync (optional, per lane)** — when creating a GitHub-linked lane,
tick "Ask an agent to keep GitHub issues in sync" and pick one of your
agents. The agent is added to the lane channel and briefed there with
standing duties: mirror new cards to GitHub issues, sync Done/Closed in
both directions, import GitHub-originated issues as cards, and reconcile
on demand (mention it with "sync"). It uses **its own machine's `gh`
login — the board never stores a GitHub token.** Cross-links are the
mapping: `buzz:<issue-id>` markers in GitHub issue bodies, and
`GitHub: <url>` recorded in NIP-34 status-event content on the buzz side
(rendered as a GH↗ chip on the card). The sync agent counts as a status
actor for the lane's cards — tagging it on the lane record is the owner
delegating that authority, so GitHub-side closes can move cards.

**Card** — a NIP-34 git issue. Six columns: Triage, Backlog, In Progress,
In Review, Done, Closed. Drag within a lane to move and to prioritize
(vertical order is shared). Cards can't move across lanes — their repo
reference is immutable.

**Assignment** — pick one of *your* agents (the board only offers agents
you own; other members' agents ignore your mentions by `respond_to`
policy). With dispatch enabled, the board posts an instruction message in
the lane channel: how to read the issue, and that `--status open` = claimed,
`--status resolved` = ready for review, `--status draft` = blocked. Agents
not in the lane channel are flagged — mentions can't reach them.

**Agent lifecycle** — status events published by the card's *assignee* mean:
`open` → In Progress, `resolved` → In Review (only the author/owner's
resolved means Done — agents never close their own work), `draft` →
In Review with a red **⚠ blocked** badge. A blocked card's modal links the
agent's thread so you can reply and unblock, spin a new ticket, or drag the
card back to Backlog. Human recovery moves always win by recency.

## On-the-wire model

Everything is an event on the relay; buzzboard invents no new kinds.

| Board concept | Relay representation |
|---|---|
| Swimlane | kind 30617 repo announcement (`d` = lane slug) |
| Lane ↔ channel binding | `["buzz-channel", <uuid>]` on the announcement (existing buzz web-client convention) |
| Lane ↔ GitHub binding | standard NIP-34 `["web", url]` + `["clone", url]` tags |
| Lane sync agent | `["sync-agent", <pubkey>]` on the announcement |
| Card ↔ GitHub issue | `buzz:<issue-id>` marker in the GitHub issue body; `GitHub: <url>` in buzz status-event content |
| Card | kind 1621 issue (`a` = `30617:<owner>:<lane>`, `subject`, `t` labels) |
| Column | NIP-34 status events 1630/1631/1632/1633 (+ `t:in-progress` / `t:in-review` on 1630 — the CLI-expressible vocabulary can't say In Progress/In Review otherwise) |
| Vertical order | `["rank", <base36>]` on the newest status event carrying one — fractional index, inserting never renumbers neighbors |
| Assignee | `["assignee", <pubkey>]` on the newest status event carrying one |
| Agent thread | `["dispatch", <msgId>, <channelUuid>]` on the assignment's status event → rendered as a `buzz://message?…` deep link |
| Dispatch / wake-up | kind 9 message in the lane channel with `["p", <agent>]` |
| Canvas board link | kind 40100 canvas: one `📋 [Open buzzboard](…)` line, merged idempotently — never clobbers human content |

Derivation rules (ported from buzz desktop's `projectIssues.mjs`, extended):

- **Column** counts status events only from *strict actors* — issue author,
  repo owner, current assignee, or the lane's declared sync agent; newest
  wins.
- **Rank and assignee** read the newest tag from *any* member — anyone may
  reorder or assign, but can't move a column they're not authorized for.
- Status events are fetched by `#a` **and** `#e` — `buzz issues status`
  omits the repo tag unless given repo flags, so agent statuses are often
  only reachable via the issue id.

## Buzz integration, both directions

- **Board → buzz:** card 💬 chips and blocked notices deep-link into the
  agent's thread (`buzz://message?…`), opening the Buzz desktop app at the
  right spot.
- **Buzz → board:** each lane's channel canvas carries an "Open buzzboard"
  link (auto-written at lane creation; the 📋 chip refreshes it). It points
  at `localhost`, which is per-viewer by design: every colleague who clicks
  it opens *their own* local instance at that lane. Standardize on port
  8401.

## Multi-user model

Give colleagues this repo. Each runs the app locally with their own key.
There is no shared deployment, no accounts, no sync service — the relay is
the single source of truth and its membership is the access control. What
one person drags, everyone sees on the next 5-second poll.

## Tests

```bash
cd spa && npm test    # vitest
```

The domain layer is pure logic over plain event objects, so the suite runs
against an in-memory stub relay with a real filter matcher — no mocking
framework. Covered: rank fractional-index invariants, the full column
derivation matrix (strict vs loose actors, assignee lifecycle, blocked,
label fallbacks, newest-wins recovery, `#a`+`#e` status merge), sync-agent
authority + GitHub cross-link extraction, canvas link merging, and every
action builder's published event kinds/tags (moves, assignment + dispatch,
card mirror requests, lane creation, channel attach). Crypto is verified
end-to-end: event ids, BIP-340 signatures, NIP-98 headers.

## Known limitations

- Issue title/body are immutable after creation (NIP-34 has no issue edit);
  clarifications go in the dispatch thread.
- Column moves stick only for the issue author, lane owner, or assignee.
- The buzz desktop shows a coarser view (it doesn't know these conventions):
  assignee-resolved reads as Done there, in-progress/in-review as Backlog.
- Board writes re-derive from a 5 s poll, not live subscriptions.
- Concurrent edits resolve by newest-event-wins; no operational transforms.

- GitHub sync is best-effort/eventually-consistent: it depends on the sync
  agent being online, and everything it mirrors to GitHub is authored as
  its owner's GitHub identity.

## Roadmap

- **Tauri wrapper:** signed app bundle, key in the OS keychain, a
  `buzzboard://` scheme so canvas links launch the app.
- **Relay-served bundle:** the relay already multiplexes SPA bundles; a
  small upstream PR could serve the board at `https://<relay>/board`.
- **Upstream card kind:** a proper addressable card event (status, assignee,
  rank as first-class fields) would replace the status-event conventions —
  this prototype is the design brief for that PR.
