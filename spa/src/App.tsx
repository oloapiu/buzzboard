import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./app.css";
import { Board } from "./Board";
import { cardOrder, fetchBoard, type BoardData } from "./lib/board";
import type { Column } from "./lib/kinds";
import { GearIcon, UsersIcon } from "./Icons";
import { parsePrivateKey, Signer } from "./lib/nostr";
import { Relay } from "./lib/relay";

export default function App() {
  const [relayUrl, setRelayUrl] = useState(localStorage.getItem("buzzboard.relay") ?? "");
  const [key, setKey] = useState(localStorage.getItem("buzzboard.key") ?? "");
  const [editing, setEditing] = useState(!relayUrl || !key);
  const [data, setData] = useState<BoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false); // true while dragging or a modal is open

  const session = useMemo(() => {
    if (editing || !relayUrl || !key) return null;
    try {
      const signer = new Signer(parsePrivateKey(key));
      return { signer, relay: new Relay(relayUrl, signer) };
    } catch (err) {
      setError(String(err));
      return null;
    }
  }, [relayUrl, key, editing]);

  const refresh = useCallback(async () => {
    if (!session) return;
    try {
      setData(await fetchBoard(session.relay, session.signer.pubkey));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [session]);

  // instant local echo of a drag — the relay publish + refetch reconcile later
  const optimisticMove = useCallback(
    (laneAddress: string, cardId: string, column: Column, rank: string) => {
      setData((d) => {
        if (!d) return d;
        const cards = new Map(d.cards);
        const list = [...(cards.get(laneAddress) ?? [])];
        const i = list.findIndex((c) => c.id === cardId);
        if (i < 0) return d;
        list[i] = { ...list[i], column, rank, blocked: false };
        list.sort(cardOrder);
        cards.set(laneAddress, list);
        return { ...d, cards };
      });
    },
    [],
  );

  useEffect(() => {
    if (!session) return;
    refresh();
    const timer = setInterval(() => {
      if (!busyRef.current) refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [session, refresh]);

  function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    localStorage.setItem("buzzboard.relay", relayUrl.trim());
    localStorage.setItem("buzzboard.key", key.trim());
    setEditing(false);
  }

  if (editing || !session) {
    return (
      <main className="settings">
        <h1>buzzboard</h1>
        <p className="muted">
          A kanban over your buzz community. Your key stays in this browser.
        </p>
        <form onSubmit={saveSettings}>
          <label>
            Relay URL
            <input value={relayUrl} onChange={(e) => setRelayUrl(e.target.value)}
                   placeholder="wss://relay.example.com" required />
          </label>
          <label>
            Private key (nsec or hex)
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} required />
          </label>
          <button type="submit">Connect</button>
        </form>
        {error && <div className="error">{error}</div>}
      </main>
    );
  }

  const communityHost = (() => {
    try {
      return new URL(relayUrl.replace(/^ws(s?):\/\//, "http$1://")).hostname;
    } catch {
      return relayUrl;
    }
  })();
  const myName =
    data?.names.get(session.signer.pubkey) ?? `${session.signer.pubkey.slice(0, 8)}…`;

  return (
    <div>
      <header className="topbar">
        <div className="brand">
          <span className="wordmark"><em>buzz</em>board</span>
          <span className="brand-sep" aria-hidden />
          <span className="community" title={relayUrl}>
            <UsersIcon />{communityHost}
          </span>
        </div>
        <div className="topbar-right">
          <span className="user-chip" title={session.signer.pubkey}>{myName}</span>
          <button className="icon-btn" onClick={() => setEditing(true)} title="Settings">
            <GearIcon />
          </button>
        </div>
      </header>
      {error && <div className="error">{error}</div>}
      {data ? (
        <Board data={data} session={session} refresh={refresh} busyRef={busyRef}
               optimisticMove={optimisticMove} />
      ) : (
        <p className="muted center">Loading board…</p>
      )}
    </div>
  );
}
