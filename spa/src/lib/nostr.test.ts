import { verifyEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import { bytesToHex, parsePrivateKey, Signer } from "./nostr.ts";

const HEX_KEY = "0000000000000000000000000000000000000000000000000000000000000003";
const NSEC_KEY = "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqps52s3re";

describe("parsePrivateKey", () => {
  it("accepts hex and nsec forms of the same key identically", () => {
    expect(bytesToHex(parsePrivateKey(HEX_KEY))).toBe(HEX_KEY);
    expect(bytesToHex(parsePrivateKey(NSEC_KEY))).toBe(HEX_KEY);
    expect(bytesToHex(parsePrivateKey(`  0x${HEX_KEY} `))).toBe(HEX_KEY);
  });

  it("rejects malformed input", () => {
    expect(() => parsePrivateKey("nsec1invalid")).toThrow();
    expect(() => parsePrivateKey("abc")).toThrow();
    expect(() => parsePrivateKey("z".repeat(64))).toThrow();
  });
});

describe("Signer", () => {
  const signer = new Signer(parsePrivateKey(HEX_KEY));

  it("produces events that verify (NIP-01 id + BIP-340 signature)", () => {
    const ev = signer.signEvent(1, [["t", "test"]], "héllo\nworld");
    expect(ev.pubkey).toBe(signer.pubkey);
    expect(verifyEvent(ev)).toBe(true);
  });

  it("builds NIP-98 headers with u/method/nonce/payload tags", async () => {
    const url = "https://relay.example.com/query";
    const body = '[{"kinds":[1621]}]';
    const header = await signer.nip98Header("post", url, body);
    expect(header.startsWith("Nostr ")).toBe(true);
    const ev = JSON.parse(atob(header.slice("Nostr ".length)));
    const tags = new Map(ev.tags as [string, string][]);
    expect(ev.kind).toBe(27235);
    expect(tags.get("u")).toBe(url);
    expect(tags.get("method")).toBe("POST");
    expect(tags.get("nonce")).toBeTruthy();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    expect(tags.get("payload")).toBe(bytesToHex(new Uint8Array(digest)));
    expect(verifyEvent(ev)).toBe(true);
  });

  it("omits the payload tag without a body", async () => {
    const header = await signer.nip98Header("POST", "https://x.example/events");
    const ev = JSON.parse(atob(header.slice("Nostr ".length)));
    expect(ev.tags.some((t: string[]) => t[0] === "payload")).toBe(false);
  });
});
