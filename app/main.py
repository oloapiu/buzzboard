"""buzzboard — a Trello-style board over buzz NIP-34 issues.

FastAPI + HTMX + Alpine + Tailwind + SortableJS. All shared state lives on
the buzz relay as Nostr events; rank + assignee are board-local (SQLite).
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from . import board, store
from .nostr import Signer, npub, parse_private_key
from .relay import Relay, RelayError

app = FastAPI(title="buzzboard")
templates = Jinja2Templates(directory=Path(__file__).resolve().parent / "templates")
templates.env.filters["short_pk"] = lambda pk: (pk or "")[:8]


def get_relay() -> tuple[Relay, Signer] | None:
    url = store.get_setting("relay_url")
    key = store.get_setting("privkey_hex")
    if not url or not key:
        return None
    signer = Signer(key)
    return Relay(url, signer), signer


def error_html(exc: Exception) -> HTMLResponse:
    return HTMLResponse(
        f'<div class="m-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">'
        f"{type(exc).__name__}: {exc}</div>"
    )


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    ctx = get_relay()
    identity = npub(ctx[1].pubkey) if ctx else None
    return templates.TemplateResponse(
        request, "index.html", {"configured": ctx is not None, "identity": identity}
    )


# --- settings ---

@app.get("/settings", response_class=HTMLResponse)
def settings_page(request: Request):
    ctx = get_relay()
    channels: list[dict] = []
    channel_error = None
    if ctx:
        try:
            channels = board.fetch_channels(ctx[0], ctx[1].pubkey)
        except RelayError as exc:
            channel_error = str(exc)
    return templates.TemplateResponse(
        request,
        "settings.html",
        {
            "relay_url": store.get_setting("relay_url") or "",
            "has_key": bool(store.get_setting("privkey_hex")),
            "identity": npub(ctx[1].pubkey) if ctx else None,
            "channels": channels,
            "channel_error": channel_error,
            "dispatch_channel": store.get_setting("dispatch_channel") or "",
            "configured": ctx is not None,
        },
    )


@app.post("/settings")
def save_settings(
    relay_url: str = Form(...),
    private_key: str = Form(""),
    dispatch_channel: str = Form(""),
):
    store.set_setting("relay_url", relay_url.strip())
    if private_key.strip():
        store.set_setting("privkey_hex", parse_private_key(private_key))
    if dispatch_channel:
        store.set_setting("dispatch_channel", dispatch_channel)
    return RedirectResponse("/settings", status_code=303)


@app.post("/repos", response_class=HTMLResponse)
def create_repo(repo_id: str = Form(...), name: str = Form(""), description: str = Form("")):
    ctx = get_relay()
    if not ctx:
        return error_html(RuntimeError("configure relay + key first"))
    relay, signer = ctx
    try:
        event = board.build_repo_event(signer, repo_id.strip(), name.strip() or repo_id.strip(), description.strip())
        relay.submit(event)
    except (RelayError, ValueError) as exc:
        return error_html(exc)
    return RedirectResponse("/", status_code=303)


# --- board ---

@app.get("/partials/board", response_class=HTMLResponse)
def board_partial(request: Request):
    ctx = get_relay()
    if not ctx:
        return HTMLResponse("")
    relay, signer = ctx
    try:
        data = board.fetch_board(relay, signer.pubkey)
    except RelayError as exc:
        return error_html(exc)
    return templates.TemplateResponse(
        request,
        "partials/board.html",
        {
            "repos": data["repos"],
            "cards_by_repo": data["cards_by_repo"],
            "names": data["names"],
            "columns": board.COLUMNS,
            "column_labels": board.COLUMN_LABELS,
        },
    )


# --- cards ---

@app.get("/partials/new-card", response_class=HTMLResponse)
def new_card_form(request: Request, repo: str):
    return templates.TemplateResponse(request, "partials/new_card.html", {"repo": repo})


@app.post("/cards", response_class=HTMLResponse)
def create_card(
    repo: str = Form(...),
    subject: str = Form(...),
    body: str = Form(""),
    labels: str = Form(""),
):
    ctx = get_relay()
    if not ctx:
        return error_html(RuntimeError("not configured"))
    relay, signer = ctx
    owner = board.repo_owner_from_address(repo)
    repo_id = repo.split(":")[2]
    label_list = [label.strip() for label in labels.split(",") if label.strip()]
    try:
        event = board.build_issue_event(signer, owner, repo_id, subject.strip(), body, label_list)
        relay.submit(event)
    except (RelayError, ValueError) as exc:
        return error_html(exc)
    return HTMLResponse("", headers={"HX-Trigger": "refresh"})


@app.get("/partials/card/{issue_id}", response_class=HTMLResponse)
def card_detail(request: Request, issue_id: str, repo: str):
    ctx = get_relay()
    if not ctx:
        return error_html(RuntimeError("not configured"))
    relay, signer = ctx
    try:
        events = relay.query([{"kinds": [board.KIND_GIT_ISSUE], "ids": [issue_id], "limit": 1}])
        if not events:
            return error_html(RuntimeError("issue not found"))
        issue = events[0]
        statuses = relay.query(
            [{"kinds": board.STATUS_KINDS, "#e": [issue_id], "limit": 100}]
        )
        agents = board.fetch_agents(
            relay, store.get_setting("dispatch_channel"), my_pubkey=signer.pubkey
        )
    except RelayError as exc:
        return error_html(exc)
    meta = store.all_card_meta().get(issue_id, {})
    status_event = board.latest_status(issue, statuses, meta.get("assignee"))
    return templates.TemplateResponse(
        request,
        "partials/card_detail.html",
        {
            "issue": issue,
            "repo": repo,
            "subject": board.tag_value(issue, "subject") or "(untitled)",
            "labels": board.tag_values(issue, "t"),
            "column": board.derive_column(issue, status_event, meta.get("assignee")),
            "blocked": board.is_blocked(status_event, meta.get("assignee")),
            "thread_link": (
                f"buzz://message?channel={meta['dispatch_channel']}&id={meta['dispatch_event_id']}"
                if meta.get("dispatch_event_id") and meta.get("dispatch_channel")
                else None
            ),
            "columns": board.COLUMNS,
            "column_labels": board.COLUMN_LABELS,
            "agents": agents,
            "assignee": meta.get("assignee") or "",
            "dispatch_channel": store.get_setting("dispatch_channel") or "",
        },
    )


@app.post("/cards/move", response_class=HTMLResponse)
def move_card(
    moved: str = Form(...),
    repo: str = Form(...),
    column: str = Form(...),
    from_column: str = Form(""),
    ordered: str = Form(""),
):
    ctx = get_relay()
    if not ctx:
        return error_html(RuntimeError("not configured"))
    relay, signer = ctx
    if column not in board.COLUMNS:
        return error_html(ValueError(f"unknown column {column}"))
    try:
        if column != from_column:
            event = board.build_status_event(signer, moved, repo, column)
            relay.submit(event)
        if ordered:
            store.set_ranks([i for i in ordered.split(",") if i])
    except RelayError as exc:
        return error_html(exc)
    return HTMLResponse("", headers={"HX-Trigger": "refresh"})


@app.post("/cards/{issue_id}/assign", response_class=HTMLResponse)
def assign_card(
    issue_id: str,
    repo: str = Form(...),
    subject: str = Form(""),
    assignee: str = Form(""),
    dispatch: str = Form(""),
):
    ctx = get_relay()
    if not ctx:
        return error_html(RuntimeError("not configured"))
    relay, signer = ctx
    assignee = assignee.strip().lower()
    store.set_assignee(issue_id, assignee or None)
    if assignee and dispatch:
        channel = store.get_setting("dispatch_channel")
        if not channel:
            return error_html(RuntimeError("no dispatch channel configured in settings"))
        try:
            names = board.fetch_profile_names(relay, [assignee])
            agent_name = names.get(assignee, assignee[:8])
            card = {"id": issue_id, "subject": subject or issue_id[:8]}
            event = board.build_dispatch_message(
                signer, channel, assignee, agent_name, card, repo
            )
            relay.submit(event)
            store.set_dispatch(issue_id, event["id"], channel)
        except RelayError as exc:
            return error_html(exc)
    return HTMLResponse("", headers={"HX-Trigger": "refresh"})
