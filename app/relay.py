"""HTTP client for the buzz relay bridge endpoints (POST /query, POST /events).

Mirrors crates/buzz-cli/src/client.rs: ws(s):// URLs are normalized to
http(s)://, every request carries a freshly signed NIP-98 Authorization
header, filters are POSTed as a JSON array, writes POST one signed event.
"""

from __future__ import annotations

import json

import httpx

from .nostr import Signer


class RelayError(Exception):
    pass


def normalize_relay_url(url: str) -> str:
    url = url.strip().rstrip("/")
    if url.startswith("ws://"):
        url = "http://" + url[len("ws://") :]
    elif url.startswith("wss://"):
        url = "https://" + url[len("wss://") :]
    elif not url.startswith(("http://", "https://")):
        url = "https://" + url
    return url


class Relay:
    def __init__(self, url: str, signer: Signer, timeout: float = 15.0):
        self.base = normalize_relay_url(url)
        self.signer = signer
        self._http = httpx.Client(timeout=timeout)

    def _post(self, path: str, payload) -> httpx.Response:
        url = f"{self.base}{path}"
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
        headers = {
            "Authorization": self.signer.nip98_header("POST", url, body),
            "Content-Type": "application/json",
        }
        try:
            return self._http.post(url, content=body, headers=headers)
        except httpx.HTTPError as exc:
            raise RelayError(f"relay unreachable: {exc}") from exc

    def query(self, filters: list[dict]) -> list[dict]:
        resp = self._post("/query", filters)
        if resp.status_code != 200:
            raise RelayError(f"query failed ({resp.status_code}): {resp.text[:300]}")
        data = resp.json()
        if not isinstance(data, list):
            raise RelayError(f"unexpected query response: {str(data)[:300]}")
        return data

    def submit(self, event: dict) -> dict:
        resp = self._post("/events", event)
        if resp.status_code not in (200, 201, 202):
            raise RelayError(f"publish failed ({resp.status_code}): {resp.text[:300]}")
        try:
            return resp.json()
        except ValueError:
            return {}
