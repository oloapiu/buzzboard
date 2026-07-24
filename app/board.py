"""Board domain logic: fetch NIP-34 events from the relay, derive columns,
publish issue / status / dispatch events.

Status derivation ports desktop/src/features/projects/projectIssues.mjs from
block/buzz, with one soft extension: label tags (`t`) on the *latest status
event* are honored before the issue's own labels, which lets cards move to
In Progress / In Review after creation (kind 1630 + t-tag). The buzz desktop
currently ignores status-event labels and will show such cards as Backlog.
"""

from __future__ import annotations

import json
import re

from . import store
from .nostr import Signer
from .relay import Relay

KIND_PROFILE = 0
KIND_STREAM_MESSAGE = 9
KIND_GIT_ISSUE = 1621
KIND_STATUS_OPEN = 1630
KIND_STATUS_RESOLVED = 1631
KIND_STATUS_CLOSED = 1632
KIND_STATUS_DRAFT = 1633
KIND_AGENT_PROFILE = 10100
KIND_MANAGED_AGENT = 30177
KIND_REPO_ANNOUNCEMENT = 30617
KIND_GROUP_METADATA = 39000
KIND_GROUP_MEMBERS = 39002

STATUS_KINDS = [KIND_STATUS_OPEN, KIND_STATUS_RESOLVED, KIND_STATUS_CLOSED, KIND_STATUS_DRAFT]

COLUMNS = ["triage", "backlog", "in_progress", "in_review", "done", "closed"]
COLUMN_LABELS = {
    "triage": "Triage",
    "backlog": "Backlog",
    "in_progress": "In Progress",
    "in_review": "In Review",
    "done": "Done",
    "closed": "Closed",
}

REPO_ID_RE = re.compile(r"^(?!\.)(?!.*\.\.)[a-zA-Z0-9._-]{1,64}$")


def tag_value(event: dict, name: str) -> str | None:
    for tag in event.get("tags", []):
        if len(tag) >= 2 and tag[0] == name:
            return tag[1]
    return None


def tag_values(event: dict, name: str) -> list[str]:
    return [t[1] for t in event.get("tags", []) if len(t) >= 2 and t[0] == name]


def repo_owner_from_address(address: str | None) -> str | None:
    if not address:
        return None
    parts = address.split(":")
    if len(parts) == 3 and parts[0] == "30617" and len(parts[1]) == 64:
        return parts[1].lower()
    return None


# --- status derivation (ported from projectIssues.mjs) ---

def allowed_actors(issue: dict) -> set[str]:
    allowed = {issue["pubkey"].lower()}
    owner = repo_owner_from_address(tag_value(issue, "a"))
    if owner:
        allowed.add(owner)
    return allowed


def latest_status(
    issue: dict, status_events: list[dict], assignee: str | None = None
) -> dict | None:
    actors = allowed_actors(issue)
    if assignee:
        actors.add(assignee.lower())
    candidates = [
        ev
        for ev in status_events
        if ev["pubkey"].lower() in actors
        and any(len(t) >= 2 and t[0] == "e" and t[1] == issue["id"] for t in ev.get("tags", []))
    ]
    candidates.sort(key=lambda ev: ev["created_at"], reverse=True)
    return candidates[0] if candidates else None


def _column_from_labels(labels: list[str]) -> str | None:
    labels = [label.lower() for label in labels]
    if "in-review" in labels or "review" in labels:
        return "in_review"
    if "in-progress" in labels or "active" in labels:
        return "in_progress"
    if "triage" in labels:
        return "triage"
    return None


def derive_column(
    issue: dict, status_event: dict | None, assignee: str | None = None
) -> str:
    if status_event:
        # assignee lifecycle: the buzz CLI can only express open/resolved/
        # closed/draft, so for the card's assignee (typically an agent),
        # open = claimed/working, resolved = ready for human review, and
        # draft = blocked — also surfaced in In Review (the human-action
        # queue) with a blocked badge. Done stays reserved for author/owner.
        if assignee and status_event["pubkey"].lower() == assignee.lower():
            if status_event["kind"] == KIND_STATUS_OPEN and not _column_from_labels(
                tag_values(status_event, "t")
            ):
                return "in_progress"
            if status_event["kind"] in (KIND_STATUS_RESOLVED, KIND_STATUS_DRAFT):
                return "in_review"
        if status_event["kind"] == KIND_STATUS_RESOLVED:
            return "done"
        if status_event["kind"] == KIND_STATUS_CLOSED:
            return "closed"
        if status_event["kind"] == KIND_STATUS_DRAFT:
            return "triage"
        # extension: labels on the latest status event (lets cards move
        # to in_progress / in_review after creation)
        from_status = _column_from_labels(tag_values(status_event, "t"))
        if from_status:
            return from_status
    from_issue = _column_from_labels(tag_values(issue, "t"))
    return from_issue or "backlog"


def is_blocked(status_event: dict | None, assignee: str | None) -> bool:
    """Blocked = the latest counted status is the assignee's `draft`."""
    return bool(
        status_event
        and assignee
        and status_event["pubkey"].lower() == assignee.lower()
        and status_event["kind"] == KIND_STATUS_DRAFT
    )


# --- fetching ---

def fetch_repos(relay: Relay) -> list[dict]:
    events = relay.query([{"kinds": [KIND_REPO_ANNOUNCEMENT], "limit": 200}])
    latest: dict[tuple[str, str], dict] = {}
    for ev in events:
        d = tag_value(ev, "d")
        if d is None:
            continue
        key = (ev["pubkey"].lower(), d)
        if key not in latest or ev["created_at"] > latest[key]["created_at"]:
            latest[key] = ev
    repos = []
    for (owner, d), ev in latest.items():
        repos.append(
            {
                "address": f"30617:{owner}:{d}",
                "owner": owner,
                "repo_id": d,
                "name": tag_value(ev, "name") or d,
                "description": tag_value(ev, "description") or "",
            }
        )
    repos.sort(key=lambda r: r["name"].lower())
    return repos


def fetch_board(relay: Relay, my_pubkey: str) -> dict:
    repos = fetch_repos(relay)
    addresses = [r["address"] for r in repos]
    issues: list[dict] = []
    statuses: list[dict] = []
    if addresses:
        issues = relay.query([{"kinds": [KIND_GIT_ISSUE], "#a": addresses, "limit": 500}])
        # fetch statuses by repo (#a) AND by issue id (#e): the buzz CLI's
        # `issues status` omits the `a` tag unless given repo flags, so
        # agent-published statuses are often only reachable via #e
        statuses = relay.query([{"kinds": STATUS_KINDS, "#a": addresses, "limit": 500}])
        issue_ids = [ev["id"] for ev in issues]
        if issue_ids:
            by_id = {ev["id"]: ev for ev in statuses}
            for ev in relay.query([{"kinds": STATUS_KINDS, "#e": issue_ids, "limit": 500}]):
                by_id.setdefault(ev["id"], ev)
            statuses = list(by_id.values())

    meta = store.all_card_meta()
    by_repo: dict[str, list[dict]] = {addr: [] for addr in addresses}
    pubkeys: set[str] = {my_pubkey}
    for issue in issues:
        address = tag_value(issue, "a")
        if address not in by_repo:
            continue
        card_meta = meta.get(issue["id"], {})
        status_event = latest_status(issue, statuses, card_meta.get("assignee"))
        pubkeys.add(issue["pubkey"].lower())
        if card_meta.get("assignee"):
            pubkeys.add(card_meta["assignee"])
        updated_at = max(
            [issue["created_at"]] + ([status_event["created_at"]] if status_event else [])
        )
        thread_link = None
        if card_meta.get("dispatch_event_id") and card_meta.get("dispatch_channel"):
            thread_link = (
                f"buzz://message?channel={card_meta['dispatch_channel']}"
                f"&id={card_meta['dispatch_event_id']}"
            )
        by_repo[address].append(
            {
                "id": issue["id"],
                "subject": tag_value(issue, "subject") or "(untitled)",
                "body": issue.get("content", ""),
                "labels": tag_values(issue, "t"),
                "author": issue["pubkey"].lower(),
                "created_at": issue["created_at"],
                "updated_at": updated_at,
                "column": derive_column(issue, status_event, card_meta.get("assignee")),
                "blocked": is_blocked(status_event, card_meta.get("assignee")),
                "thread_link": thread_link,
                "rank": card_meta.get("rank"),
                "assignee": card_meta.get("assignee"),
            }
        )

    for cards in by_repo.values():
        cards.sort(
            key=lambda c: (
                c["rank"] if c["rank"] is not None else 1e9,
                -c["updated_at"],
            )
        )

    names = fetch_profile_names(relay, sorted(pubkeys))
    return {"repos": repos, "cards_by_repo": by_repo, "names": names}


def fetch_profile_names(relay: Relay, pubkeys: list[str]) -> dict[str, str]:
    names: dict[str, str] = {}
    if not pubkeys:
        return names
    events = relay.query([{"kinds": [KIND_PROFILE], "authors": pubkeys, "limit": 500}])
    latest: dict[str, dict] = {}
    for ev in events:
        pk = ev["pubkey"].lower()
        if pk not in latest or ev["created_at"] > latest[pk]["created_at"]:
            latest[pk] = ev
    for pk, ev in latest.items():
        try:
            content = json.loads(ev.get("content") or "{}")
        except ValueError:
            content = {}
        name = content.get("display_name") or content.get("name")
        if name:
            names[pk] = name
    return names


def _content_json(ev: dict) -> dict:
    try:
        parsed = json.loads(ev.get("content") or "{}")
        return parsed if isinstance(parsed, dict) else {}
    except ValueError:
        return {}


def fetch_agents(
    relay: Relay, dispatch_channel: str | None = None, my_pubkey: str | None = None
) -> list[dict]:
    """Union of the ways buzz marks agents (mirrors the desktop app):
    managed agents (kind 30177, d = agent pubkey, name in content JSON),
    relay agent profiles (kind 10100), kind-0 profiles carrying a NIP-OA
    `auth` tag, and `bot`-role members of the dispatch channel roster.

    When my_pubkey is given, agents owned by *other* members are dropped —
    every member gets their own copies of the default agents, and agents
    gate on who mentions them (respond_to), so another owner's agent would
    ignore our dispatch anyway.
    """
    found: dict[str, str | None] = {}  # pubkey -> best-known name
    owners: dict[str, str] = {}  # agent pubkey -> owner pubkey

    def add(pk: str | None, name: str | None = None, owner: str | None = None) -> None:
        if not pk or len(pk) != 64:
            return
        pk = pk.lower()
        if pk not in found or (name and not found[pk]):
            found[pk] = name or found.get(pk)
        if owner and pk not in owners:
            owners[pk] = owner.lower()

    # managed agents — authoritative names; author = owner
    for ev in relay.query([{"kinds": [KIND_MANAGED_AGENT], "limit": 200}]):
        add(tag_value(ev, "d"), _content_json(ev).get("name"), owner=ev["pubkey"])

    # relay agent profiles
    for ev in relay.query([{"kinds": [KIND_AGENT_PROFILE], "limit": 200}]):
        content = _content_json(ev)
        add(ev["pubkey"], content.get("display_name") or content.get("name"))

    # kind-0 profiles with a NIP-OA owner-attestation tag are agents;
    # the tag is ["auth", owner_pubkey, conditions, sig]
    for ev in relay.query([{"kinds": [KIND_PROFILE], "limit": 500}]):
        auth = next(
            (t for t in ev.get("tags", []) if t and t[0] == "auth" and len(t) == 4), None
        )
        if auth:
            content = _content_json(ev)
            add(ev["pubkey"], content.get("display_name") or content.get("name"), owner=auth[1])

    # dispatch-channel roster: bot-role members are agents, and membership of
    # any kind determines whether a dispatch mention can actually reach them
    roster: set[str] = set()
    if dispatch_channel:
        for ev in relay.query(
            [{"kinds": [KIND_GROUP_MEMBERS], "#d": [dispatch_channel], "limit": 10}]
        ):
            for t in ev.get("tags", []):
                if len(t) >= 2 and t[0] == "p":
                    roster.add(t[1].lower())
                    if len(t) >= 4 and t[3] == "bot":
                        add(t[1])

    # fill remaining names from kind-0 profiles
    unnamed = [pk for pk, name in found.items() if not name]
    if unnamed:
        for pk, name in fetch_profile_names(relay, unnamed).items():
            found[pk] = name

    if my_pubkey:
        my_pubkey = my_pubkey.lower()
        found = {
            pk: name
            for pk, name in found.items()
            if owners.get(pk, my_pubkey) == my_pubkey  # keep unknown-owner agents
        }

    agents = [
        {"pubkey": pk, "name": name or pk[:12], "in_channel": pk in roster}
        for pk, name in found.items()
    ]
    agents.sort(key=lambda a: (not a["in_channel"], a["name"].lower()))
    return agents


def fetch_channels(relay: Relay, my_pubkey: str) -> list[dict]:
    """Channels I'm a member of: 39002 (#p=me) -> uuids, then 39000 (#d) for names."""
    member_events = relay.query(
        [{"kinds": [KIND_GROUP_MEMBERS], "#p": [my_pubkey], "limit": 200}]
    )
    uuids = sorted({tag_value(ev, "d") for ev in member_events if tag_value(ev, "d")})
    if not uuids:
        return []
    meta_events = relay.query([{"kinds": [KIND_GROUP_METADATA], "#d": uuids, "limit": 200}])
    channels = []
    for ev in meta_events:
        d = tag_value(ev, "d")
        if not d:
            continue
        tags = {t[0] for t in ev.get("tags", []) if t}
        if "hidden" in tags:  # DMs
            continue
        channels.append({"uuid": d, "name": tag_value(ev, "name") or d[:8]})
    channels.sort(key=lambda c: c["name"].lower())
    return channels


# --- publishing ---

def build_issue_event(
    signer: Signer, repo_owner: str, repo_id: str, subject: str, body: str, labels: list[str]
) -> dict:
    tags = [["a", f"30617:{repo_owner}:{repo_id}"], ["p", repo_owner], ["subject", subject]]
    for label in labels:
        tags.append(["t", label])
    return signer.sign_event(KIND_GIT_ISSUE, tags, body)


COLUMN_TO_STATUS: dict[str, tuple[int, list[str]]] = {
    "triage": (KIND_STATUS_DRAFT, []),
    "backlog": (KIND_STATUS_OPEN, []),
    "in_progress": (KIND_STATUS_OPEN, ["in-progress"]),
    "in_review": (KIND_STATUS_OPEN, ["in-review"]),
    "done": (KIND_STATUS_RESOLVED, []),
    "closed": (KIND_STATUS_CLOSED, []),
}


def build_status_event(signer: Signer, issue_id: str, repo_address: str, column: str) -> dict:
    kind, labels = COLUMN_TO_STATUS[column]
    tags = [["e", issue_id, "", "root"], ["a", repo_address]]
    owner = repo_owner_from_address(repo_address)
    if owner:
        tags.append(["p", owner])
    for label in labels:
        tags.append(["t", label])
    return signer.sign_event(kind, tags, "")


def build_repo_event(signer: Signer, repo_id: str, name: str, description: str) -> dict:
    if not REPO_ID_RE.match(repo_id):
        raise ValueError("repo id must be [a-zA-Z0-9._-]{1,64}, no leading dot, no '..'")
    tags = [["d", repo_id], ["name", name]]
    if description:
        tags.append(["description", description])
    return signer.sign_event(KIND_REPO_ANNOUNCEMENT, tags, "")


def build_dispatch_message(
    signer: Signer,
    channel_uuid: str,
    agent_pubkey: str,
    agent_name: str,
    card: dict,
    repo_address: str,
) -> dict:
    content = (
        f"@{agent_name} you've been assigned: **{card['subject']}**\n"
        f"- issue: `{card['id']}`\n"
        f"- repo: `{repo_address}`\n\n"
        f"Read it with `buzz issues get --event {card['id']}`. "
        f"When you start, run `buzz issues status --issue {card['id']} --status open` "
        f"(the board moves the card to In Progress) and reply in this thread with progress. "
        f"When you're done, set `--status resolved` — the board moves the card to "
        f"In Review for human sign-off; don't close it yourself. "
        f"If you're blocked, set `--status draft` — the card is flagged as blocked "
        f"for human review — and explain in this thread exactly what you need."
    )
    tags = [["h", channel_uuid], ["p", agent_pubkey.lower()]]
    return signer.sign_event(KIND_STREAM_MESSAGE, tags, content)
