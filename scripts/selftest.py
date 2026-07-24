"""Sanity-check the Nostr crypto without a relay: event id determinism,
BIP-340 signature verification, nsec round-trip, NIP-98 header decoding."""

import base64
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from coincurve import PublicKeyXOnly  # noqa: E402

from app.nostr import Signer, bech32_encode, npub, parse_private_key  # noqa: E402

PRIV = "0000000000000000000000000000000000000000000000000000000000000003"

signer = Signer(PRIV)

# nsec round-trip
nsec = bech32_encode("nsec", bytes.fromhex(PRIV))
assert parse_private_key(nsec) == PRIV, "nsec round-trip failed"
assert parse_private_key(PRIV) == PRIV
print(f"nsec round-trip ok ({nsec[:12]}…), npub {npub(signer.pubkey)[:16]}…")

# event id determinism + canonical serialization
event = signer.sign_event(1, [["t", "test"], ["p", signer.pubkey]], "héllo\nworld", created_at=1700000000)
expected = hashlib.sha256(
    json.dumps(
        [0, signer.pubkey, 1700000000, 1, [["t", "test"], ["p", signer.pubkey]], "héllo\nworld"],
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode()
).hexdigest()
assert event["id"] == expected, "event id mismatch"
print(f"event id ok: {event['id'][:16]}…")

# BIP-340 verify against the x-only pubkey
pub = PublicKeyXOnly(bytes.fromhex(signer.pubkey))
assert pub.verify(bytes.fromhex(event["sig"]), bytes.fromhex(event["id"])), "schnorr verify failed"
print("schnorr signature verifies against x-only pubkey")

# NIP-98 header decodes to a well-formed kind-27235 event
header = signer.nip98_header("POST", "https://relay.example.com/query", b'[{"kinds":[1621]}]')
assert header.startswith("Nostr ")
auth_event = json.loads(base64.b64decode(header[len("Nostr "):]))
tags = {t[0]: t[1] for t in auth_event["tags"]}
assert auth_event["kind"] == 27235
assert tags["u"] == "https://relay.example.com/query"
assert tags["method"] == "POST"
assert tags["payload"] == hashlib.sha256(b'[{"kinds":[1621]}]').hexdigest()
assert "nonce" in tags
pub.verify(bytes.fromhex(auth_event["sig"]), bytes.fromhex(auth_event["id"]))
print("NIP-98 header ok (u/method/nonce/payload tags, valid signature)")

print("\nall self-tests passed")
