// Client-side Nostr primitives: key parsing, NIP-01 signing, NIP-98 auth.
// TypeScript port of v1's app/nostr.py, backed by nostr-tools + Web Crypto.

import { finalizeEvent, getPublicKey, type Event } from "nostr-tools/pure";
import { decode } from "nostr-tools/nip19";

export type SignedEvent = Event;

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

/** Accept nsec1... or 64-char hex; return 32-byte secret key. */
export function parsePrivateKey(value: string): Uint8Array {
  const trimmed = value.trim();
  if (trimmed.toLowerCase().startsWith("nsec1")) {
    const decoded = decode(trimmed);
    if (decoded.type !== "nsec") throw new Error("invalid nsec");
    return decoded.data;
  }
  const cleaned = trimmed.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(cleaned)) {
    throw new Error("expected nsec1… or 64-char hex private key");
  }
  return hexToBytes(cleaned);
}

export class Signer {
  readonly pubkey: string;
  private readonly secret: Uint8Array;

  constructor(secret: Uint8Array) {
    this.secret = secret;
    this.pubkey = getPublicKey(secret);
  }

  signEvent(kind: number, tags: string[][], content: string): SignedEvent {
    return finalizeEvent(
      { kind, tags, content, created_at: Math.floor(Date.now() / 1000) },
      this.secret,
    );
  }

  /** NIP-98: kind-27235 event with u/method/nonce[/payload] tags, base64-encoded. */
  async nip98Header(method: string, url: string, body?: string): Promise<string> {
    const tags = [
      ["u", url],
      ["method", method.toUpperCase()],
      ["nonce", crypto.randomUUID()],
    ];
    if (body) {
      tags.push(["payload", await sha256Hex(body)]);
    }
    const event = this.signEvent(27235, tags, "");
    const token = btoa(
      String.fromCharCode(...new TextEncoder().encode(JSON.stringify(event))),
    );
    return `Nostr ${token}`;
  }
}
