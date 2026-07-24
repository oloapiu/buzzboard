import { useEffect, useState } from "react";
import { COLUMNS, COLUMN_LABELS, type Column } from "./lib/kinds";
import {
  addBoardLinkToCanvas, assignCard, attachChannel, createCard, createLane,
  fetchMyChannels, laneBoardUrl, moveCard,
  type Agent, type Card, type Lane,
} from "./lib/board";
import type { Session } from "./Board";

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

export function NewCardModal({ lane, session, close, refresh }: {
  lane: Lane; session: Session; close: () => void; refresh: () => Promise<void>;
}) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState("");
  const { busy, error, run } = useAction(close, refresh);
  return (
    <Overlay close={close}>
      <h2>New card in {lane.name}</h2>
      <form onSubmit={(e) => {
        e.preventDefault();
        run(() => createCard(session.relay, session.signer, lane, subject.trim(), body,
          labels.split(",").map((l) => l.trim()).filter(Boolean)));
      }}>
        <input autoFocus required placeholder="Title" value={subject}
               onChange={(e) => setSubject(e.target.value)} />
        <textarea rows={5} placeholder="Description (markdown)" value={body}
                  onChange={(e) => setBody(e.target.value)} />
        <input placeholder="labels, comma-separated" value={labels}
               onChange={(e) => setLabels(e.target.value)} />
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button type="button" className="ghost" onClick={close}>Cancel</button>
          <button type="submit" disabled={busy}>{busy ? "Creating…" : "Create"}</button>
        </div>
      </form>
    </Overlay>
  );
}

export function CardModal({ card, lane, session, agents, nameOf, close, refresh }: {
  card: Card; lane: Lane; session: Session;
  agents: (Agent & { inChannel: boolean })[];
  nameOf: (pk: string | null | undefined) => string;
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
        <button className="ghost" onClick={close}>✕</button>
      </div>
      <p className="muted mono">{card.id.slice(0, 16)}… · {lane.name} · by {nameOf(card.author)}</p>

      {card.blocked && (
        <div className="notice">
          <strong>⚠ The agent is blocked</strong> and needs your input.{" "}
          {card.threadLink && (<>Read its report and reply in{" "}
            <a href={card.threadLink}>the Buzz thread</a> — </>)}
          or spin the ask into a new ticket, or move this card back to Backlog.
        </div>
      )}
      {card.body && <pre className="body">{card.body}</pre>}
      {card.threadLink && !card.blocked && (
        <p><a href={card.threadLink}>💬 Open the agent thread in Buzz</a></p>
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

      <div className="row">
        <label>
          Assignee
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">— unassigned —</option>
            {agents.map((a) => (
              <option key={a.pubkey} value={a.pubkey}>
                🤖 {a.name} ({a.pubkey.slice(0, 8)}){a.inChannel ? "" : " — ⚠ not in lane channel"}
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
  const { busy, error, run } = useAction(close, refresh);
  return (
    <Overlay close={close}>
      <h2>New swimlane</h2>
      <p className="muted">
        Creates a channel for the lane's discussion and agent dispatch. Linking a
        GitHub repo lets a lane agent keep GitHub issues in sync.
      </p>
      <form onSubmit={(e) => {
        e.preventDefault();
        run(() => createLane(session.relay, session.signer, name.trim(), description.trim(),
          githubUrl.trim(), [...staff], null, window.location.origin));
      }}>
        <input autoFocus required placeholder="Lane name" value={name}
               onChange={(e) => setName(e.target.value)} />
        <input placeholder="Description (optional)" value={description}
               onChange={(e) => setDescription(e.target.value)} />
        <input placeholder="GitHub repo URL (optional)" value={githubUrl}
               onChange={(e) => setGithubUrl(e.target.value)} />
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
                🤖 {a.name}
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
