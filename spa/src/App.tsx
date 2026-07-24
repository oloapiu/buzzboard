// v2 scaffold: connection probe. Verifies from a real browser context that
// the relay's CORS policy admits the NIP-98 Authorization header — the one
// open question for the pure-static-SPA architecture. Becomes the settings
// screen once the board lands.

import { useState } from "react";
import { parsePrivateKey, Signer } from "./lib/nostr";
import { Relay } from "./lib/relay";

type ProbeResult =
  | { state: "idle" }
  | { state: "running" }
  | { state: "ok"; repos: string[]; pubkey: string }
  | { state: "error"; kind: "cors" | "http" | "input"; message: string };

export default function App() {
  const [relayUrl, setRelayUrl] = useState(localStorage.getItem("buzzboard.relay") ?? "");
  const [key, setKey] = useState(localStorage.getItem("buzzboard.key") ?? "");
  const [result, setResult] = useState<ProbeResult>({ state: "idle" });

  async function runProbe() {
    setResult({ state: "running" });
    localStorage.setItem("buzzboard.relay", relayUrl);
    localStorage.setItem("buzzboard.key", key);
    let signer: Signer;
    try {
      signer = new Signer(parsePrivateKey(key));
    } catch (err) {
      setResult({ state: "error", kind: "input", message: String(err) });
      return;
    }
    const relay = new Relay(relayUrl, signer);
    try {
      const events = await relay.query([{ kinds: [30617], limit: 20 }]);
      const repos = events
        .map((ev) => ev.tags.find((t) => t[0] === "name")?.[1] ?? ev.tags.find((t) => t[0] === "d")?.[1])
        .filter((n): n is string => Boolean(n));
      setResult({ state: "ok", repos, pubkey: signer.pubkey });
    } catch (err) {
      // fetch() rejects with TypeError when CORS/preflight blocks the request;
      // HTTP-level failures surface as our own Error with a status code.
      const isCors = err instanceof TypeError;
      setResult({
        state: "error",
        kind: isCors ? "cors" : "http",
        message: isCors
          ? `Request blocked before reaching the relay (likely CORS/preflight): ${err.message}. ` +
            "Check the browser devtools console — if the preflight rejected the Authorization " +
            "header, the wildcard-exclusion caveat applies."
          : String(err),
      });
    }
  }

  return (
    <main style={{ maxWidth: 560, margin: "4rem auto", fontFamily: "system-ui", lineHeight: 1.5 }}>
      <h1>buzzboard v2 — relay probe</h1>
      <p style={{ color: "#555" }}>
        Signs a NIP-98 query in the browser and calls <code>POST /query</code> cross-origin.
      </p>
      <label style={{ display: "block", marginTop: 16 }}>
        Relay URL
        <input
          value={relayUrl}
          onChange={(e) => setRelayUrl(e.target.value)}
          placeholder="wss://relay.example.com"
          style={{ width: "100%", padding: 8, fontFamily: "monospace" }}
        />
      </label>
      <label style={{ display: "block", marginTop: 12 }}>
        Private key (nsec or hex)
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          style={{ width: "100%", padding: 8, fontFamily: "monospace" }}
        />
      </label>
      <button
        onClick={runProbe}
        disabled={result.state === "running" || !relayUrl || !key}
        style={{ marginTop: 16, padding: "8px 20px" }}
      >
        {result.state === "running" ? "Probing…" : "Run probe"}
      </button>

      {result.state === "ok" && (
        <div style={{ marginTop: 20, padding: 12, background: "#e7f7e7", borderRadius: 6 }}>
          <strong>✅ CORS + NIP-98 work from the browser.</strong>
          <p>Signed as <code>{result.pubkey.slice(0, 16)}…</code></p>
          <p>
            {result.repos.length} repo(s): {result.repos.join(", ") || "(none yet)"}
          </p>
        </div>
      )}
      {result.state === "error" && (
        <div style={{ marginTop: 20, padding: 12, background: "#fdeaea", borderRadius: 6 }}>
          <strong>{result.kind === "cors" ? "🚫 Blocked by browser" : "⚠ Failed"}</strong>
          <p style={{ whiteSpace: "pre-wrap" }}>{result.message}</p>
        </div>
      )}
    </main>
  );
}
