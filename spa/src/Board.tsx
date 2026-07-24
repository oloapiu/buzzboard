import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { COLUMNS, COLUMN_LABELS, type Column } from "./lib/kinds";
import {
  addBoardLinkToCanvas, laneBoardUrl, moveCard,
  type Agent, type BoardData, type Card, type Lane,
} from "./lib/board";
import { rankBetween } from "./lib/rank";
import {
  AlertIcon, BotIcon, CheckIcon, ClipboardIcon, GithubIcon, MessageIcon, PlusIcon,
  SearchIcon, XIcon,
} from "./Icons";
import type { Signer } from "./lib/nostr";
import type { Relay } from "./lib/relay";
import {
  CardModal, DemoThreadModal, NewCardModal, NewLaneModal, AttachChannelModal,
} from "./Modals";

export interface Session {
  relay: Relay;
  signer: Signer;
  demo?: boolean;
}

type Modal =
  | { kind: "none" }
  | { kind: "card"; card: Card; lane: Lane }
  | { kind: "new-card"; lane: Lane }
  | { kind: "new-lane" }
  | { kind: "attach-channel"; lane: Lane }
  | { kind: "demo-thread"; card: Card };

export function Board({ data, session, refresh, busyRef, optimisticMove }: {
  data: BoardData;
  session: Session;
  refresh: () => Promise<void>;
  busyRef: MutableRefObject<boolean>;
  optimisticMove: (lane: string, cardId: string, column: Column, rank: string) => void;
}) {
  const [modal, setModalState] = useState<Modal>({ kind: "none" });
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const dragging = useRef<{ cardId: string; lane: string } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape" && e.target === searchRef.current) {
        setQuery("");
        searchRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);


  const setModal = (m: Modal) => {
    busyRef.current = m.kind !== "none";
    setModalState(m);
  };

  const nameOf = (pk: string | null | undefined): string => {
    if (!pk) return "";
    return data.names.get(pk.toLowerCase()) ?? pk.slice(0, 8);
  };

  const q = query.trim().toLowerCase();
  const laneMatches = (lane: Lane): boolean => {
    if (!q) return true;
    if ([lane.name, lane.repoId, lane.description].some((s) => s.toLowerCase().includes(q))) {
      return true;
    }
    return (data.cards.get(lane.address) ?? []).some(
      (c) =>
        c.subject.toLowerCase().includes(q) ||
        c.labels.some((l) => l.toLowerCase().includes(q)) ||
        (c.assignee ? nameOf(c.assignee).toLowerCase().includes(q) : false),
    );
  };
  const visibleLanes = data.lanes.filter(laneMatches);

  function onDrop(lane: Lane, column: Column, e: React.DragEvent) {
    e.preventDefault();
    setDropTarget(null);
    const drag = dragging.current;
    dragging.current = null;
    if (!drag || drag.lane !== lane.address) { busyRef.current = false; return; }
    const all = data.cards.get(lane.address) ?? [];
    const card = all.find((c) => c.id === drag.cardId);
    if (!card) { busyRef.current = false; return; }

    // insertion index from pointer position among the target cell's cards
    const cell = e.currentTarget as HTMLElement;
    const others = [...cell.querySelectorAll<HTMLElement>("[data-card]")]
      .filter((el) => el.dataset.card !== card.id);
    let index = others.length;
    for (let i = 0; i < others.length; i++) {
      const rect = others[i].getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) { index = i; break; }
    }
    const target = all.filter((c) => c.column === column && c.id !== card.id);
    // nearest *ranked* neighbors — unranked cards can't anchor a rank
    const before = target.slice(0, index).reverse().find((c) => c.rank !== null) ?? null;
    const after = target.slice(index).find((c) => c.rank !== null) ?? null;

    // move locally right now; publish + reconcile in the background
    const rank = rankBetween(before?.rank ?? "", after?.rank ?? "");
    optimisticMove(lane.address, card.id, column, rank);
    busyRef.current = true; // hold off polling until the relay has the event
    moveCard(session.relay, session.signer, lane, card, column, { before, after })
      .then(() => refresh())
      .catch((err) => { alert(String(err)); return refresh(); })
      .finally(() => { busyRef.current = modal.kind !== "none"; });
  }

  return (
    <main className="board">
      {data.lanes.length > 0 && (
        <div className="board-toolbar">
          <div className="search">
            <SearchIcon />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter lanes and cards…"
              aria-label="Filter swimlanes"
            />
            {query ? (
              <button className="icon-btn sm" title="Clear" onClick={() => setQuery("")}>
                <XIcon />
              </button>
            ) : (
              <kbd title="Press / to search">/</kbd>
            )}
          </div>
          {q && (
            <span className="muted">
              {visibleLanes.length} of {data.lanes.length} lanes
            </span>
          )}
        </div>
      )}
      {data.lanes.length === 0 && (
        <p className="muted center">No lanes yet — create your first one.</p>
      )}
      {data.lanes.length > 0 && visibleLanes.length === 0 && (
        <p className="muted center">No lanes or cards match “{query}”.</p>
      )}
      {visibleLanes.map((lane) => (
        <section key={lane.address} className="lane" id={`lane-${lane.repoId}`}>
          <div className="lane-head">
            <div className="lane-info">
              <div className="lane-title-row">
                <h2 className="lane-name">{lane.name}</h2>
                <div className="lane-actions">
                  {lane.githubUrl && (
                    <a className="icon-btn sm" href={lane.githubUrl} target="_blank"
                       rel="noreferrer" title="GitHub repository"><GithubIcon /></a>
                  )}
                  {lane.channelId && <CanvasLinkChip lane={lane} session={session} />}
                  {!lane.channelId && lane.owner === session.signer.pubkey && (
                    <button className="pill warn"
                            onClick={() => setModal({ kind: "attach-channel", lane })}>
                      <AlertIcon />attach channel
                    </button>
                  )}
                </div>
              </div>
              {lane.description && <p className="lane-desc">{lane.description}</p>}
            </div>
            <button className="ghost sm" onClick={() => setModal({ kind: "new-card", lane })}>
              <PlusIcon />Card
            </button>
          </div>
          <div className="columns">
            {COLUMNS.map((col) => {
              const cell = (data.cards.get(lane.address) ?? []).filter((c) => c.column === col);
              const cellKey = `${lane.address}:${col}`;
              return (
                <div key={col} className="column">
                  <div className="column-head">
                    <span><i className={`dot dot-${col}`} />{COLUMN_LABELS[col]}</span>
                    <span className="count">{cell.length}</span>
                  </div>
                  <div
                    className={`cell${dropTarget === cellKey ? " drop-over" : ""}`}
                    onDragOver={(e) => {
                      if (dragging.current?.lane === lane.address) {
                        e.preventDefault();
                        if (dropTarget !== cellKey) setDropTarget(cellKey);
                      }
                    }}
                    onDragLeave={(e) => {
                      if (e.currentTarget === e.target && dropTarget === cellKey) {
                        setDropTarget(null);
                      }
                    }}
                    onDrop={(e) => onDrop(lane, col, e)}
                  >
                    {cell.map((card) => (
                      <div
                        key={card.id}
                        data-card={card.id}
                        className="card"
                        draggable
                        onDragStart={() => {
                          busyRef.current = true;
                          dragging.current = { cardId: card.id, lane: lane.address };
                        }}
                        onDragEnd={() => {
                          busyRef.current = modal.kind !== "none";
                          dragging.current = null;
                          setDropTarget(null);
                        }}
                        onClick={() => setModal({ kind: "card", card, lane })}
                      >
                        <div className="card-title">{card.subject}</div>
                        <div className="card-meta">
                          {card.blocked && (
                            <span className="badge blocked"><AlertIcon />Blocked</span>
                          )}
                          {card.labels.map((l) => <span key={l} className="badge">{l}</span>)}
                          {card.threadLink && (session.demo ? (
                            <button className="icon-btn sm" title="Agent thread (demo)"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setModal({ kind: "demo-thread", card });
                                    }}>
                              <MessageIcon />
                            </button>
                          ) : (
                            <a href={card.threadLink} className="icon-btn sm"
                               onClick={(e) => e.stopPropagation()} title="Open thread in Buzz">
                              <MessageIcon />
                            </a>
                          ))}
                          {card.githubIssueUrl && (
                            <a href={card.githubIssueUrl} className="icon-btn sm" target="_blank"
                               rel="noreferrer" onClick={(e) => e.stopPropagation()}
                               title="Mirrored GitHub issue"><GithubIcon /></a>
                          )}
                          {card.assignee && (
                            <span className="badge assignee" title={card.assignee}>
                              <BotIcon />{nameOf(card.assignee)}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
      <button className="new-lane" onClick={() => setModal({ kind: "new-lane" })}>
        + New swimlane
      </button>

      {modal.kind === "card" && (
        <CardModal card={modal.card} lane={modal.lane} session={session}
                   agents={agentsForLane(data.agents, modal.lane)} nameOf={nameOf}
                   onDemoThread={session.demo
                     ? (card) => setModal({ kind: "demo-thread", card })
                     : undefined}
                   close={() => setModal({ kind: "none" })} refresh={refresh} />
      )}
      {modal.kind === "demo-thread" && (
        <DemoThreadModal card={modal.card} nameOf={nameOf}
                         close={() => setModal({ kind: "none" })} />
      )}
      {modal.kind === "new-card" && (
        <NewCardModal lane={modal.lane} session={session}
                      syncAgentName={modal.lane.syncAgent ? nameOf(modal.lane.syncAgent) : undefined}
                      close={() => setModal({ kind: "none" })} refresh={refresh} />
      )}
      {modal.kind === "new-lane" && (
        <NewLaneModal session={session} agents={data.agents}
                      close={() => setModal({ kind: "none" })} refresh={refresh} />
      )}
      {modal.kind === "attach-channel" && (
        <AttachChannelModal lane={modal.lane} session={session}
                            close={() => setModal({ kind: "none" })} refresh={refresh} />
      )}
    </main>
  );
}

function CanvasLinkChip({ lane, session }: { lane: Lane; session: Session }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  return (
    <button
      className={`icon-btn sm${state === "done" ? " ok" : ""}`}
      disabled={state !== "idle"}
      title="Write an 'Open buzzboard' link into the lane channel's canvas"
      onClick={async () => {
        setState("busy");
        try {
          await addBoardLinkToCanvas(session.relay, session.signer, lane.channelId!,
            laneBoardUrl(window.location.origin, lane));
          setState("done");
          setTimeout(() => setState("idle"), 2000);
        } catch (err) {
          setState("idle");
          alert(String(err));
        }
      }}
    >
      {state === "done" ? <CheckIcon /> : <ClipboardIcon />}
    </button>
  );
}

function agentsForLane(agents: Agent[], lane: Lane): (Agent & { inChannel: boolean })[] {
  return agents.map((a) => ({
    ...a,
    inChannel: lane.channelId ? a.channels.has(lane.channelId) : false,
  })).sort((a, b) => Number(b.inChannel) - Number(a.inChannel) || a.name.localeCompare(b.name));
}
