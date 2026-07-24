import { useEffect, useState } from "react";
import { COLUMNS, COLUMN_LABELS, type Column } from "./lib/kinds";
import {
  addBoardLinkToCanvas, assignCard, attachChannel, createCard, createLane,
  fetchMyChannels, githubSlug, laneBoardUrl, moveCard,
  type Agent, type Card, type Lane,
} from "./lib/board";
import type { Session } from "./Board";
import { BotIcon, GithubIcon, XIcon } from "./Icons";

function Overlay({ children, close }: { children: React.ReactNode; close: () => void }) {
  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal">{children}</div>
    </div>
  );
}

function useAction(close: () => void, refresh: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
      close();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function NewCardModal({ lane, session, syncAgentName, spinFrom, close, refresh }: {
  lane: Lane; session: Session; syncAgentName?: string; spinFrom?: Card;
  close: () => void; refresh: () => Promise<void>;
}) {
  const [subject, setSubject] = useState(spinFrom ? `Follow-up: ${spinFrom.subject}` : "");
  const [body, setBody] = useState(
    spinFrom
      ? `Follow-up to "${spinFrom.subject}" (\`${spinFrom.id}\`).\n\nWhat's needed:\n`
      : "",
  );
  const [labels, setLabels] = useState("");
  const [needsTriage, setNeedsTriage] = useState(Boolean(spinFrom));
  const [closeOriginal, setCloseOriginal] = useState(Boolean(spinFrom));
  const { busy, error, run } = useAction(close, refresh);
  return (
    <Overlay close={close}>
      <h2>{spinFrom ? "Spin off a new ticket" : `New card in ${lane.name}`}</h2>
      {spinFrom && (
        <p className="muted">
          Cards are immutable — a sharper ticket replaces editing. The original stays
          linked via its id in the description.
        </p>
      )}
      {lane.syncAgent && (
        <p className="muted">This lane is GitHub-synced — the sync agent will be asked to mirror the card.</p>
      )}
      <form onSubmit={(e) => {
        e.preventDefault();
        const parsed = labels.split(",").map((l) => l.trim()).filter(Boolean);
        if (needsTriage && !parsed.some((l) => l.toLowerCase() === "triage")) {
          parsed.push("triage");
        }
        run(async () => {
          await createCard(session.relay, session.signer, lane, subject.trim(), body,
            parsed, syncAgentName);
          if (spinFrom && closeOriginal) {
            await moveCard(session.relay, session.signer, lane, spinFrom, "closed",
              { before: null, after: null });
          }
        });
      }}>
        <input autoFocus required placeholder="Title" value={subject}
               onChange={(e) => setSubject(e.target.value)} />
        <textarea rows={5} placeholder="Description (markdown)" value={body}
                  onChange={(e) => setBody(e.target.value)} />
        <input placeholder="labels, comma-separated" value={labels}
               onChange={(e) => setLabels(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={needsTriage}
                 onChange={(e) => setNeedsTriage(e.target.checked)} />
          Needs triage — start in the Triage column until someone accepts it
        </label>
        {spinFrom && (
          <label className="check">
            <input type="checkbox" checked={closeOriginal}
                   onChange={(e) => setCloseOriginal(e.target.checked)} />
            Close the original card
          </label>
        )}
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button type="button" className="ghost" onClick={close}>Cancel</button>
          <button type="submit" disabled={busy}>{busy ? "Creating…" : "Create"}</button>
        </div>
      </form>
    </Overlay>
  );
}

export function CardModal({ card, lane, session, agents, nameOf, onDemoThread, onSpinOff, close, refresh }: {
  card: Card; lane: Lane; session: Session;
  agents: (Agent & { inChannel: boolean })[];
  nameOf: (pk: string | null | undefined) => string;
  onDemoThread?: (card: Card) => void;
  onSpinOff: () => void;
  close: () => void; refresh: () => Promise<void>;
}) {
  const [column, setColumn] = useState<Column>(card.column);
  const [assignee, setAssignee] = useState(card.assignee ?? "");
  const [dispatch, setDispatch] = useState(true);
  const { busy, error, run } = useAction(close, refresh);
  const canDispatch = Boolean(lane.channelId);

  return (
    <Overlay close={close}>
      <div className="modal-head">
        <h2>{card.subject}</h2>
        <button className="icon-btn" onClick={close} title="Close"><XIcon /></button>
      </div>
      <p className="muted mono">{card.id.slice(0, 16)}… · {lane.name} · by {nameOf(card.author)}</p>

      {card.blocked && (
        <div className="notice">
          <strong>⚠ The agent is blocked</strong> and needs your input.{" "}
          {card.threadLink && (<>Read its report and reply in{" "}
            {onDemoThread
              ? <a href="#thread" onClick={(e) => { e.preventDefault(); onDemoThread(card); }}>the Buzz thread</a>
              : <a href={card.threadLink}>the Buzz thread</a>}{" — "}</>)}
          or{" "}
          <a href="#spin-off" onClick={(e) => { e.preventDefault(); onSpinOff(); }}>
            spin the ask into a new ticket
          </a>, or move this card back to Backlog.
        </div>
      )}
      {card.body && <pre className="body">{card.body}</pre>}
      {card.threadLink && !card.blocked && (
        <p>
          {onDemoThread
            ? <a href="#thread" onClick={(e) => { e.preventDefault(); onDemoThread(card); }}>💬 Open the agent thread</a>
            : <a href={card.threadLink}>💬 Open the agent thread in Buzz</a>}
        </p>
      )}
      {card.githubIssueUrl && (
        <p className="inline-link"><GithubIcon />
          <a href={card.githubIssueUrl} target="_blank" rel="noreferrer">Mirrored GitHub issue</a>
        </p>
      )}

      <div className="row">
        <label>
          Column
          <select value={column} onChange={(e) => setColumn(e.target.value as Column)}>
            {COLUMNS.map((c) => <option key={c} value={c}>{COLUMN_LABELS[c]}</option>)}
          </select>
        </label>
        <button disabled={busy || column === card.column}
                onClick={() => run(() => moveCard(session.relay, session.signer, lane, card,
                  column, { before: null, after: null }))}>
          Move
        </button>
      </div>

      {!card.blocked && (
        <p className="muted">
          Need a sharper version of this ticket?{" "}
          <a href="#spin-off" onClick={(e) => { e.preventDefault(); onSpinOff(); }}>
            Spin off a new one
          </a>{" "}
          (cards are immutable).
        </p>
      )}

      <div className="row">
        <label>
          Assignee
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">— unassigned —</option>
            {agents.map((a) => (
              <option key={a.pubkey} value={a.pubkey}>
                {a.name} · {a.pubkey.slice(0, 8)}{a.inChannel ? "" : "  ⚠ not in lane channel"}
              </option>
            ))}
          </select>
        </label>
        <button disabled={busy}
                onClick={() => run(() => assignCard(session.relay, session.signer, lane, card,
                  assignee, nameOf(assignee), dispatch && canDispatch,
                  nameOf(session.signer.pubkey) || session.signer.pubkey.slice(0, 8)))}>
          Assign
        </button>
      </div>
      <label className="check">
        <input type="checkbox" checked={dispatch} disabled={!canDispatch}
               onChange={(e) => setDispatch(e.target.checked)} />
        Post assignment message in the lane channel (wakes the agent)
        {!canDispatch && <span className="error-inline"> — lane has no channel</span>}
      </label>
      {error && <div className="error">{error}</div>}
    </Overlay>
  );
}

export function NewLaneModal({ session, agents, close, refresh }: {
  session: Session; agents: Agent[]; close: () => void; refresh: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [githubUrl, setGithubUrl] = useState("");
  const [staff, setStaff] = useState<Set<string>>(new Set());
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [syncAgent, setSyncAgent] = useState("");
  const { busy, error, run } = useAction(close, refresh);
  const githubLinked = Boolean(githubSlug(githubUrl.trim() || ""));
  const syncing = githubLinked && syncEnabled && syncAgent;
  return (
    <Overlay close={close}>
      <h2>New swimlane</h2>
      <p className="muted">
        Creates a channel for the lane's discussion and agent dispatch. Linking a
        GitHub repo lets a lane agent keep GitHub issues in sync.
      </p>
      <form onSubmit={(e) => {
        e.preventDefault();
        // the sync agent must be in the lane channel to receive its duties
        const staffed = syncing ? new Set(staff).add(syncAgent) : staff;
        run(() => createLane(session.relay, session.signer, name.trim(), description.trim(),
          githubUrl.trim(), [...staffed], null, window.location.origin,
          syncing ? syncAgent : null,
          syncing ? agents.find((a) => a.pubkey === syncAgent)?.name : undefined));
      }}>
        <input autoFocus required placeholder="Lane name" value={name}
               onChange={(e) => setName(e.target.value)} />
        <input placeholder="Description (optional)" value={description}
               onChange={(e) => setDescription(e.target.value)} />
        <input placeholder="GitHub repo URL (optional)" value={githubUrl}
               onChange={(e) => setGithubUrl(e.target.value)} />
        {githubLinked && (
          <fieldset>
            <legend>GitHub sync</legend>
            <label className="check">
              <input type="checkbox" checked={syncEnabled}
                     onChange={(e) => setSyncEnabled(e.target.checked)} />
              Ask an agent to keep GitHub issues in sync with this lane
            </label>
            {syncEnabled && (
              <>
                <select value={syncAgent} onChange={(e) => setSyncAgent(e.target.value)}>
                  <option value="">— pick the sync agent —</option>
                  {agents.map((a) => (
                    <option key={a.pubkey} value={a.pubkey}>{a.name} · {a.pubkey.slice(0, 8)}</option>
                  ))}
                </select>
                <p className="muted">
                  The agent mirrors cards to GitHub issues and back using its own machine's
                  `gh` login — the board never stores a GitHub token. It'll be added to the
                  lane channel and briefed there.
                </p>
              </>
            )}
          </fieldset>
        )}
        {agents.length > 0 && (
          <fieldset>
            <legend>Staff the lane (adds agents to its channel)</legend>
            {agents.map((a) => (
              <label key={a.pubkey} className="check">
                <input type="checkbox" checked={staff.has(a.pubkey)}
                       onChange={(e) => {
                         const next = new Set(staff);
                         if (e.target.checked) next.add(a.pubkey); else next.delete(a.pubkey);
                         setStaff(next);
                       }} />
                <span className="agent-name"><BotIcon />{a.name}</span>
              </label>
            ))}
          </fieldset>
        )}
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button type="button" className="ghost" onClick={close}>Cancel</button>
          <button type="submit" disabled={busy}>{busy ? "Creating…" : "Create lane"}</button>
        </div>
      </form>
    </Overlay>
  );
}

export function DemoThreadModal({ card, nameOf, close }: {
  card: Card; nameOf: (pk: string | null | undefined) => string; close: () => void;
}) {
  const agent = nameOf(card.assignee) || "the agent";
  return (
    <Overlay close={close}>
      <div className="modal-head">
        <h2>Agent thread <span className="muted">(demo)</span></h2>
        <button className="icon-btn" onClick={close} title="Close"><XIcon /></button>
      </div>
      <div className="thread">
        <div className="msg me">
          <span className="who">Ada</span>
          @{agent} you've been assigned: <strong>{card.subject}</strong> — read it, report
          progress in this thread, move the card as you go.
        </div>
        <div className="msg">
          <span className="who"><BotIcon />{agent}</span>
          {card.blocked
            ? <>I'm blocked: I need a decision from you before I can continue — see the card.
                I've set the status to draft so the board flags it.</>
            : <>Claimed. I'll set the card to In Progress while I work and to In Review when
                it's ready for your sign-off.</>}
        </div>
      </div>
      <div className="explain">
        In the real app this button deep-links into the <strong>Buzz desktop app</strong> at
        this exact thread (<code>buzz://message?…</code>). There you'd read the agent's full
        report and reply to {card.blocked ? "unblock it — it resumes and moves the card itself"
        : "steer it — every status change you see here is the agent publishing signed events"}.
        In demo mode the "agent" is a local simulation, so there's no thread to open.
      </div>
    </Overlay>
  );
}

export function AttachChannelModal({ lane, session, close, refresh }: {
  lane: Lane; session: Session; close: () => void; refresh: () => Promise<void>;
}) {
  const [channels, setChannels] = useState<{ uuid: string; name: string }[] | null>(null);
  const [choice, setChoice] = useState("");
  const { busy, error, run } = useAction(close, refresh);
  useEffect(() => {
    fetchMyChannels(session.relay, session.signer.pubkey)
      .then(setChannels)
      .catch(() => setChannels([]));
  }, [session]);
  return (
    <Overlay close={close}>
      <h2>Attach a channel to {lane.name}</h2>
      <p className="muted">
        Dispatch messages and agent threads for this lane will live in the chosen channel.
      </p>
      {channels === null ? <p className="muted">Loading channels…</p> : (
        <select value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="">— pick a channel —</option>
          {channels.map((c) => <option key={c.uuid} value={c.uuid}>#{c.name}</option>)}
        </select>
      )}
      {error && <div className="error">{error}</div>}
      <div className="actions">
        <button className="ghost" onClick={close}>Cancel</button>
        <button disabled={busy || !choice}
                onClick={() => run(async () => {
                  await attachChannel(session.relay, session.signer, lane, choice);
                  await addBoardLinkToCanvas(session.relay, session.signer, choice,
                    laneBoardUrl(window.location.origin, lane));
                })}>
          Attach
        </button>
      </div>
    </Overlay>
  );
}
