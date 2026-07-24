"""Board-local state (SQLite): settings, card rank, card assignee.

Rank and assignee are deliberately NOT on the relay yet — NIP-34 has no
ordering/assignee field and the buzz relay rejects unregistered event
kinds, so this is per-board state until a card kind lands upstream.
"""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "board.db"

_lock = threading.Lock()


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS card_meta ("
        " issue_id TEXT PRIMARY KEY,"
        " rank REAL,"
        " assignee TEXT,"
        " dispatch_event_id TEXT,"
        " dispatch_channel TEXT)"
    )
    for column in ("dispatch_event_id", "dispatch_channel"):
        try:
            conn.execute(f"ALTER TABLE card_meta ADD COLUMN {column} TEXT")
        except sqlite3.OperationalError:
            pass  # column already exists
    return conn


def get_setting(key: str) -> str | None:
    with _lock, _conn() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None


def set_setting(key: str, value: str) -> None:
    with _lock, _conn() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


def all_card_meta() -> dict[str, dict]:
    with _lock, _conn() as conn:
        rows = conn.execute(
            "SELECT issue_id, rank, assignee, dispatch_event_id, dispatch_channel"
            " FROM card_meta"
        ).fetchall()
    return {
        r[0]: {
            "rank": r[1],
            "assignee": r[2],
            "dispatch_event_id": r[3],
            "dispatch_channel": r[4],
        }
        for r in rows
    }


def set_ranks(ordered_issue_ids: list[str]) -> None:
    """Persist the vertical order of one board cell: rank = list index."""
    with _lock, _conn() as conn:
        for index, issue_id in enumerate(ordered_issue_ids):
            conn.execute(
                "INSERT INTO card_meta (issue_id, rank) VALUES (?, ?)"
                " ON CONFLICT(issue_id) DO UPDATE SET rank = excluded.rank",
                (issue_id, float(index)),
            )


def set_assignee(issue_id: str, assignee: str | None) -> None:
    with _lock, _conn() as conn:
        conn.execute(
            "INSERT INTO card_meta (issue_id, assignee) VALUES (?, ?)"
            " ON CONFLICT(issue_id) DO UPDATE SET assignee = excluded.assignee",
            (issue_id, assignee),
        )


def set_dispatch(issue_id: str, event_id: str, channel: str) -> None:
    with _lock, _conn() as conn:
        conn.execute(
            "INSERT INTO card_meta (issue_id, dispatch_event_id, dispatch_channel)"
            " VALUES (?, ?, ?)"
            " ON CONFLICT(issue_id) DO UPDATE SET"
            " dispatch_event_id = excluded.dispatch_event_id,"
            " dispatch_channel = excluded.dispatch_channel",
            (issue_id, event_id, channel),
        )
