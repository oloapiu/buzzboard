import { useRef, useState, type MutableRefObject } from "react";
import { COLUMNS, COLUMN_LABELS, type Column } from "./lib/kinds";
import {
  moveCard, type Agent, type BoardData, type Card, type Lane,
} from "./lib/board";
import type { Signer } from "./lib/nostr";
import type { Relay } from "./lib/relay";
import { CardModal, NewCardModal, NewLaneModal, AttachChannelModal } from "./Modals";

export interface Session {
  relay: Relay;
  signer: Signer;
}

type Modal =
  | { kind: "none" }
  | { kind: "card"; card: Card; lane: Lane }
  | { kind: "new-card"; lane: Lane }
  | { kind: "new-lane" }
  | { kind: "attach-channel"; lane: Lane };

export function Board({ data, session, refresh, busyRef }: {
  data: BoardData;
  session: Session;
  refresh: () => Promise<void>;
  busyRef: MutableRefObject<boolean>;
}) {
  const [modal, setModalState] = useState<Modal>({ kind: "none" });
  const dragging = useRef<{ cardId: string; lane: string } | null>(null);

  const setModal = (m: Modal) => {
    busyRef.current = m.kind !== "none";
    setModalState(m);
  };

  const nameOf = (pk: string | null | undefined): string => {
    if (!pk) return "";
    return data.names.get(pk.toLowerCase()) ?? pk.slice(0, 8);
  };

  async function onDrop(lane: Lane, column: Column, e: React.DragEvent) {
    e.preventDefault();
    busyRef.current = false;
    const drag = dragging.current;
    dragging.current = null;
    if (!drag || drag.lane !== lane.address) return;
    const all = data.cards.get(lane.address) ?? [];
    const card = all.find((c) => c.id === drag.cardId);
    if (!card) return;

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
    try {
      await moveCard(session.relay, session.signer, lane, card, column, { before, after });
      await refresh();
    } catch (err) {
      alert(String(err));
    }
  }

  return (
    <main className="board">
      {data.lanes.length === 0 && (
        <p className="muted center">No lanes yet — create your first one.</p>
      )}
      {data.lanes.map((lane) => (
        <section key={lane.address} className="lane">
          <div className="lane-head">
            <div>
              <strong>{lane.name}</strong>
              {lane.githubUrl && (
                <a className="chip" href={lane.githubUrl} target="_blank" rel="noreferrer">GitHub ↗</a>
              )}
              {!lane.channelId && lane.owner === session.signer.pubkey && (
                <button className="chip warn" onClick={() => setModal({ kind: "attach-channel", lane })}>
                  no channel — attach
                </button>
              )}
              {lane.description && <span className="muted"> — {lane.description}</span>}
            </div>
            <button className="ghost" onClick={() => setModal({ kind: "new-card", lane })}>+ card</button>
          </div>
          <div className="columns">
            {COLUMNS.map((col) => {
              const cell = (data.cards.get(lane.address) ?? []).filter((c) => c.column === col);
              return (
                <div key={col} className="column">
                  <div className="column-head">
                    <span>{COLUMN_LABELS[col]}</span>
                    <span className="muted">{cell.length}</span>
                  </div>
                  <div
                    className="cell"
                    onDragOver={(e) => {
                      if (dragging.current?.lane === lane.address) e.preventDefault();
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
                        }}
                        onClick={() => setModal({ kind: "card", card, lane })}
                      >
                        <div className="card-title">{card.subject}</div>
                        <div className="card-meta">
                          {card.blocked && <span className="badge blocked">⚠ blocked</span>}
                          {card.labels.map((l) => <span key={l} className="badge">{l}</span>)}
                          {card.threadLink && (
                            <a href={card.threadLink} className="badge link"
                               onClick={(e) => e.stopPropagation()} title="Open thread in Buzz">💬</a>
                          )}
                          {card.assignee && (
                            <span className="badge assignee" title={card.assignee}>
                              {nameOf(card.assignee)}
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
                   close={() => setModal({ kind: "none" })} refresh={refresh} />
      )}
      {modal.kind === "new-card" && (
        <NewCardModal lane={modal.lane} session={session}
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

function agentsForLane(agents: Agent[], lane: Lane): (Agent & { inChannel: boolean })[] {
  return agents.map((a) => ({
    ...a,
    inChannel: lane.channelId ? a.channels.has(lane.channelId) : false,
  })).sort((a, b) => Number(b.inChannel) - Number(a.inChannel) || a.name.localeCompare(b.name));
}
