"""Minimal Nostr primitives: key parsing, NIP-01 event signing, NIP-98 HTTP auth.

Wire formats mirror what the buzz relay expects (verified against
crates/buzz-sdk and crates/buzz-cli in block/buzz):
  - event id = sha256 of JSON array [0, pubkey, created_at, kind, tags, content]
    serialized compactly (no spaces, UTF-8 kept raw)
  - BIP-340 schnorr signature, x-only hex pubkey
  - NIP-98: kind 27235 event with u/method/nonce[/payload] tags,
    sent as `Authorization: Nostr <base64(event_json)>`
"""

from __future__ import annotations

import base64
import hashlib
import json
import time
import uuid

from coincurve import PrivateKey

# --- bech32 (BIP-173) — enough to decode nsec/npub and encode npub ---

_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def _bech32_polymod(values: list[int]) -> int:
    gen = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]
    chk = 1
    for value in values:
        top = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ value
        for i in range(5):
            chk ^= gen[i] if ((top >> i) & 1) else 0
    return chk


def _bech32_hrp_expand(hrp: str) -> list[int]:
    return [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp]


def _convertbits(data: list[int], frombits: int, tobits: int, pad: bool) -> list[int]:
    acc = 0
    bits = 0
    ret = []
    maxv = (1 << tobits) - 1
    for value in data:
        acc = (acc << frombits) | value
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            ret.append((acc >> bits) & maxv)
    if pad and bits:
        ret.append((acc << (tobits - bits)) & maxv)
    elif not pad and (bits >= frombits or ((acc << (tobits - bits)) & maxv)):
        raise ValueError("invalid bech32 padding")
    return ret


def bech32_decode(bech: str) -> tuple[str, bytes]:
    bech = bech.strip().lower()
    if "1" not in bech:
        raise ValueError("not bech32")
    pos = bech.rindex("1")
    hrp, data_part = bech[:pos], bech[pos + 1 :]
    data = [_CHARSET.find(c) for c in data_part]
    if any(d == -1 for d in data):
        raise ValueError("invalid bech32 character")
    if _bech32_polymod(_bech32_hrp_expand(hrp) + data) != 1:
        raise ValueError("bad bech32 checksum")
    return hrp, bytes(_convertbits(data[:-6], 5, 8, False))


def bech32_encode(hrp: str, payload: bytes) -> str:
    data = _convertbits(list(payload), 8, 5, True)
    values = _bech32_hrp_expand(hrp) + data
    polymod = _bech32_polymod(values + [0, 0, 0, 0, 0, 0]) ^ 1
    checksum = [(polymod >> 5 * (5 - i)) & 31 for i in range(6)]
    return hrp + "1" + "".join(_CHARSET[d] for d in data + checksum)


def npub(pubkey_hex: str) -> str:
    return bech32_encode("npub", bytes.fromhex(pubkey_hex))


def parse_private_key(value: str) -> str:
    """Accept nsec1... or 64-char hex; return lowercase hex."""
    value = value.strip()
    if value.lower().startswith("nsec1"):
        hrp, payload = bech32_decode(value)
        if hrp != "nsec" or len(payload) != 32:
            raise ValueError("invalid nsec")
        return payload.hex()
    cleaned = value.lower().removeprefix("0x")
    if len(cleaned) == 64:
        bytes.fromhex(cleaned)  # raises on non-hex
        return cleaned
    raise ValueError("expected nsec1... or 64-char hex private key")


class Signer:
    def __init__(self, privkey_hex: str):
        self._sk = PrivateKey(bytes.fromhex(privkey_hex))
        # x-only pubkey: drop the parity byte of the compressed encoding
        self.pubkey = self._sk.public_key.format(compressed=True)[1:].hex()

    def sign_event(
        self,
        kind: int,
        tags: list[list[str]],
        content: str,
        created_at: int | None = None,
    ) -> dict:
        created_at = created_at or int(time.time())
        serialized = json.dumps(
            [0, self.pubkey, created_at, kind, tags, content],
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode()
        event_id = hashlib.sha256(serialized).hexdigest()
        sig = self._sk.sign_schnorr(bytes.fromhex(event_id)).hex()
        return {
            "id": event_id,
            "pubkey": self.pubkey,
            "created_at": created_at,
            "kind": kind,
            "tags": tags,
            "content": content,
            "sig": sig,
        }

    def nip98_header(self, method: str, url: str, body: bytes | None) -> str:
        tags = [
            ["u", url],
            ["method", method.upper()],
            ["nonce", str(uuid.uuid4())],
        ]
        if body:
            tags.append(["payload", hashlib.sha256(body).hexdigest()])
        event = self.sign_event(27235, tags, "")
        token = base64.b64encode(
            json.dumps(event, separators=(",", ":"), ensure_ascii=False).encode()
        ).decode()
        return f"Nostr {token}"
