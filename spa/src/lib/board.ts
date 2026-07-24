// Board domain logic. All shared state lives on the relay:
//   lane          = kind 30617 repo announcement; ["buzz-channel", uuid] binds
//                   its channel (existing web-client convention); ["web", url]
//                   optionally links GitHub
//   card          = kind 1621 git issue
//   column        = NIP-34 status events (strict actors: author/owner/assignee;
//                   assignee lifecycle: open=In Progress, resolved=In Review,
//                   draft=blocked→In Review)
//   rank          = ["rank", <base36>] on the newest status event carrying one
//                   (any member may reorder)
//   assignee      = ["assignee", <pubkey|"">] on the newest status event
//                   carrying one (any member may assign)
//   thread link   = ["dispatch", <msgId>, <channelUuid>] on the newest status
//                   event carrying one

import * as K from "./kinds.ts";
import type { Column } from "./kinds.ts";
import { rankBetween } from "./rank.ts";
import type { Signer, SignedEvent } from "./nostr.ts";
import { Relay } from "./relay.ts";

export interface Lane {
  address: string;
  owner: string;
  repoId: string;
  name: string;
  description: string;
  channelId: string | null;
  githubUrl: string | null;
}

export interface Card {
  id: string;
  subject: string;
  body: string;
  labels: string[];
  author: string;
  createdAt: number;
  updatedAt: number;
  column: Column;
  blocked: boolean;
  rank: string | null;
  assignee: string | null;
  threadLink: string | null;
}

export interface Agent {
  pubkey: string;
  name: string;
  channels: Set<string>;
}

export interface BoardData {
  lanes: Lane[];
  cards: Map<string, Card[]>; // lane address -> cards, sorted
  agents: Agent[];
  names: Map<string, string>;
}

// --- tag helpers ---

export const tagValue = (ev: SignedEvent, name: string): string | undefined =>
  ev.tags.find((t) => t[0] === name && t.length >= 2)?.[1];

const tagValues = (ev: SignedEvent, name: string): string[] =>
  ev.tags.filter((t) => t[0] === name && t.length >= 2).map((t) => t[1]);

const newestFirst = (a: SignedEvent, b: SignedEvent) =>
  b.created_at - a.created_at || (a.id < b.id ? -1 : 1);

const latestPerCoord = (events: SignedEvent[]): SignedEvent[] => {
  const best = new Map<string, SignedEvent>();
  for (const ev of events) {
    const key = `${ev.pubkey.toLowerCase()}:${tagValue(ev, "d") ?? ""}`;
    const seen = best.get(key);
    if (!seen || ev.created_at > seen.created_at) best.set(key, ev);
  }
  return [...best.values()];
};

// --- derivation ---

const repoOwner = (address: string | undefined): string | null => {
  const parts = address?.split(":");
  return parts?.length === 3 && parts[0] === "30617" && parts[1].length === 64
    ? parts[1].toLowerCase()
    : null;
};

const columnFromLabels = (labels: string[]): Column | null => {
  const lower = labels.map((l) => l.toLowerCase());
  if (lower.includes("in-review") || lower.includes("review")) return "in_review";
  if (lower.includes("in-progress") || lower.includes("active")) return "in_progress";
  if (lower.includes("triage")) return "triage";
  return null;
};

function deriveCard(issue: SignedEvent, statuses: SignedEvent[], names: Set<string>): Card {
  const referencing = statuses
    .filter((ev) => ev.tags.some((t) => t[0] === "e" && t[1] === issue.id))
    .sort(newestFirst);

  // loosely-derived fields: newest event carrying the tag, any member
  const assignee =
    referencing.find((ev) => ev.tags.some((t) => t[0] === "assignee"))?.tags
      .find((t) => t[0] === "assignee")?.[1] || null;
  const rank = referencing.find((ev) => tagValue(ev, "rank"))
    ? tagValue(referencing.find((ev) => tagValue(ev, "rank"))!, "rank")!
    : null;
  const dispatchTag = referencing
    .find((ev) => ev.tags.some((t) => t[0] === "dispatch" && t.length >= 3))
    ?.tags.find((t) => t[0] === "dispatch");

  // column: strict actors only
  const actors = new Set([issue.pubkey.toLowerCase()]);
  const owner = repoOwner(tagValue(issue, "a"));
  if (owner) actors.add(owner);
  if (assignee) actors.add(assignee.toLowerCase());
  const statusEvent = referencing.find((ev) => actors.has(ev.pubkey.toLowerCase())) ?? null;

  let column: Column = "backlog";
  let blocked = false;
  if (statusEvent) {
    const byAssignee = assignee && statusEvent.pubkey.toLowerCase() === assignee.toLowerCase();
    const statusLabels = columnFromLabels(tagValues(statusEvent, "t"));
    if (byAssignee && statusEvent.kind === K.KIND_STATUS_OPEN && !statusLabels) {
      column = "in_progress";
    } else if (byAssignee && statusEvent.kind === K.KIND_STATUS_RESOLVED) {
      column = "in_review";
    } else if (byAssignee && statusEvent.kind === K.KIND_STATUS_DRAFT) {
      column = "in_review";
      blocked = true;
    } else if (statusEvent.kind === K.KIND_STATUS_RESOLVED) {
      column = "done";
    } else if (statusEvent.kind === K.KIND_STATUS_CLOSED) {
      column = "closed";
    } else if (statusEvent.kind === K.KIND_STATUS_DRAFT) {
      column = "triage";
    } else {
      column = statusLabels ?? columnFromLabels(tagValues(issue, "t")) ?? "backlog";
    }
  } else {
    column = columnFromLabels(tagValues(issue, "t")) ?? "backlog";
  }

  names.add(issue.pubkey.toLowerCase());
  if (assignee) names.add(assignee.toLowerCase());

  return {
    id: issue.id,
    subject: tagValue(issue, "subject") ?? "(untitled)",
    body: issue.content,
    labels: tagValues(issue, "t"),
    author: issue.pubkey.toLowerCase(),
    createdAt: issue.created_at,
    updatedAt: Math.max(issue.created_at, referencing[0]?.created_at ?? 0),
    column,
    blocked,
    rank,
    assignee,
    threadLink: dispatchTag ? `buzz://message?channel=${dispatchTag[2]}&id=${dispatchTag[1]}` : null,
  };
}

const cardOrder = (a: Card, b: Card) => {
  if (a.rank !== null && b.rank !== null) return a.rank < b.rank ? -1 : 1;
  if (a.rank !== null) return -1;
  if (b.rank !== null) return 1;
  return b.updatedAt - a.updatedAt;
};

// --- fetching ---

export async function fetchBoard(relay: Relay, myPubkey: string): Promise<BoardData> {
  const repoEvents = latestPerCoord(
    await relay.query([{ kinds: [K.KIND_REPO_ANNOUNCEMENT], limit: 200 }]),
  );
  const lanes: Lane[] = repoEvents
    .flatMap((ev) => {
      const d = tagValue(ev, "d");
      if (!d) return [];
      return [{
        address: `30617:${ev.pubkey.toLowerCase()}:${d}`,
        owner: ev.pubkey.toLowerCase(),
        repoId: d,
        name: tagValue(ev, "name") ?? d,
        description: tagValue(ev, "description") ?? "",
        channelId: tagValue(ev, "buzz-channel") ?? null,
        githubUrl: tagValue(ev, "web") ?? null,
      }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const addresses = lanes.map((l) => l.address);
  const cards = new Map<string, Card[]>(addresses.map((a) => [a, []]));
  const nameWanted = new Set<string>([myPubkey.toLowerCase()]);

  if (addresses.length) {
    const issues = await relay.query([
      { kinds: [K.KIND_GIT_ISSUE], "#a": addresses, limit: 500 },
    ]);
    // statuses by repo AND by issue id — agent CLI statuses often lack `a`
    const byA = await relay.query([{ kinds: K.STATUS_KINDS, "#a": addresses, limit: 500 }]);
    const ids = issues.map((ev) => ev.id);
    const byE = ids.length
      ? await relay.query([{ kinds: K.STATUS_KINDS, "#e": ids, limit: 500 }])
      : [];
    const statuses = [...new Map([...byA, ...byE].map((ev) => [ev.id, ev])).values()];

    for (const issue of issues) {
      const address = tagValue(issue, "a");
      if (address && cards.has(address)) {
        cards.get(address)!.push(deriveCard(issue, statuses, nameWanted));
      }
    }
    for (const list of cards.values()) list.sort(cardOrder);
  }

  const agents = await fetchAgents(relay, myPubkey, lanes);
  for (const agent of agents) nameWanted.add(agent.pubkey);
  const names = await fetchNames(relay, [...nameWanted]);
  for (const agent of agents) {
    if (names.has(agent.pubkey)) agent.name = names.get(agent.pubkey)!;
  }
  agents.sort((a, b) => a.name.localeCompare(b.name));

  return { lanes, cards, agents, names };
}

async function fetchNames(relay: Relay, pubkeys: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!pubkeys.length) return names;
  const events = await relay.query([{ kinds: [K.KIND_PROFILE], authors: pubkeys, limit: 500 }]);
  for (const ev of events.sort((a, b) => a.created_at - b.created_at)) {
    try {
      const content = JSON.parse(ev.content || "{}");
      const name = content.display_name || content.name;
      if (name) names.set(ev.pubkey.toLowerCase(), name);
    } catch {
      /* ignore malformed profiles */
    }
  }
  return names;
}

async function fetchAgents(relay: Relay, myPubkey: string, lanes: Lane[]): Promise<Agent[]> {
  const me = myPubkey.toLowerCase();
  const found = new Map<string, Agent>();
  const add = (pk: string | undefined, name?: string) => {
    if (!pk || pk.length !== 64) return;
    pk = pk.toLowerCase();
    const existing = found.get(pk);
    if (existing) {
      if (name && existing.name === pk.slice(0, 12)) existing.name = name;
    } else {
      found.set(pk, { pubkey: pk, name: name ?? pk.slice(0, 12), channels: new Set() });
    }
  };

  // managed agents I own (authoritative names)
  for (const ev of await relay.query([{ kinds: [K.KIND_MANAGED_AGENT], authors: [me], limit: 200 }])) {
    try {
      add(tagValue(ev, "d"), JSON.parse(ev.content || "{}").name);
    } catch {
      add(tagValue(ev, "d"));
    }
  }
  // kind-0 profiles owner-attested to me (NIP-OA ["auth", owner, cond, sig])
  for (const ev of await relay.query([{ kinds: [K.KIND_PROFILE], limit: 500 }])) {
    const auth = ev.tags.find((t) => t[0] === "auth" && t.length === 4);
    if (auth && auth[1]?.toLowerCase() === me) {
      try {
        const c = JSON.parse(ev.content || "{}");
        add(ev.pubkey, c.display_name || c.name);
      } catch {
        add(ev.pubkey);
      }
    }
  }

  // lane channel rosters -> which agents are reachable where
  const channelIds = lanes.map((l) => l.channelId).filter((c): c is string => Boolean(c));
  if (channelIds.length) {
    const rosters = await relay.query([
      { kinds: [K.KIND_GROUP_MEMBERS], "#d": channelIds, limit: 100 },
    ]);
    for (const ev of rosters) {
      const channel = tagValue(ev, "d");
      if (!channel) continue;
      for (const t of ev.tags) {
        if (t[0] !== "p" || !t[1]) continue;
        const pk = t[1].toLowerCase();
        if (t[3] === "bot") add(pk);
        found.get(pk)?.channels.add(channel);
      }
    }
  }
  return [...found.values()];
}

// --- actions (each publishes events; caller refreshes afterwards) ---

const COLUMN_TO_STATUS: Record<Column, { kind: number; labels: string[] }> = {
  triage: { kind: K.KIND_STATUS_DRAFT, labels: [] },
  backlog: { kind: K.KIND_STATUS_OPEN, labels: [] },
  in_progress: { kind: K.KIND_STATUS_OPEN, labels: ["in-progress"] },
  in_review: { kind: K.KIND_STATUS_OPEN, labels: ["in-review"] },
  done: { kind: K.KIND_STATUS_RESOLVED, labels: [] },
  closed: { kind: K.KIND_STATUS_CLOSED, labels: [] },
};

function statusTags(card: Card, lane: Lane, extra: string[][]): string[][] {
  const tags: string[][] = [["e", card.id, "", "root"], ["a", lane.address], ["p", lane.owner]];
  return tags.concat(extra);
}

export async function createCard(
  relay: Relay, signer: Signer, lane: Lane,
  subject: string, body: string, labels: string[],
): Promise<void> {
  const tags: string[][] = [["a", lane.address], ["p", lane.owner], ["subject", subject]];
  for (const label of labels) tags.push(["t", label]);
  await relay.submit(signer.signEvent(K.KIND_GIT_ISSUE, tags, body));
}

export async function moveCard(
  relay: Relay, signer: Signer, lane: Lane, card: Card,
  column: Column, neighbors: { before: Card | null; after: Card | null },
): Promise<void> {
  const { kind, labels } = COLUMN_TO_STATUS[column];
  const rank = rankBetween(neighbors.before?.rank ?? "", neighbors.after?.rank ?? "");
  const extra: string[][] = labels.map((l) => ["t", l]);
  extra.push(["rank", rank]);
  await relay.submit(signer.signEvent(kind, statusTags(card, lane, extra), ""));
}

export async function assignCard(
  relay: Relay, signer: Signer, lane: Lane, card: Card,
  assignee: string, agentName: string, dispatch: boolean, myName: string,
): Promise<void> {
  const extra: string[][] = [["assignee", assignee]];
  if (assignee && dispatch && lane.channelId) {
    const content =
      `@${agentName} you've been assigned: **${card.subject}**\n` +
      `- issue: \`${card.id}\`\n- repo: \`${lane.address}\`\n\n` +
      `Read it with \`buzz issues get --event ${card.id}\`. ` +
      `When you start, run \`buzz issues status --issue ${card.id} --status open\` ` +
      `(the board moves the card to In Progress) and reply in this thread with progress. ` +
      `When you're done, set \`--status resolved\` — the board moves the card to In Review ` +
      `for human sign-off; don't close it yourself. If you're blocked, set \`--status draft\` — ` +
      `the card is flagged as blocked for human review — and explain in this thread what you need. ` +
      `(assigned by ${myName})`;
    const msg = signer.signEvent(
      K.KIND_STREAM_MESSAGE,
      [["h", lane.channelId], ["p", assignee]],
      content,
    );
    await relay.submit(msg);
    extra.push(["dispatch", msg.id, lane.channelId]);
  }
  const { kind, labels } = COLUMN_TO_STATUS[card.column];
  const tags = statusTags(card, lane, labels.map((l): string[] => ["t", l]).concat(extra));
  await relay.submit(signer.signEvent(kind, tags, ""));
}

export async function createLane(
  relay: Relay, signer: Signer,
  name: string, description: string, githubUrl: string,
  agentPubkeys: string[], existingChannelId: string | null,
): Promise<void> {
  let channelId = existingChannelId;
  if (!channelId) {
    channelId = crypto.randomUUID();
    await relay.submit(signer.signEvent(
      K.KIND_CREATE_CHANNEL,
      [["h", channelId], ["name", name], ["about", `buzzboard lane: ${name}`]],
      "",
    ));
    for (const pk of agentPubkeys) {
      await relay.submit(signer.signEvent(
        K.KIND_ADD_MEMBER, [["h", channelId], ["p", pk], ["role", "bot"]], "",
      ));
    }
  }
  const repoId = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+|[-.]+$/g, "")
    .slice(0, 64) || "lane";
  const tags: string[][] = [["d", repoId], ["name", name], ["buzz-channel", channelId]];
  if (description) tags.push(["description", description]);
  if (githubUrl) {
    tags.push(["web", githubUrl]);
    tags.push(["clone", `${githubUrl.replace(/\/+$/, "")}.git`]);
  }
  await relay.submit(signer.signEvent(K.KIND_REPO_ANNOUNCEMENT, tags, ""));
}

export async function attachChannel(
  relay: Relay, signer: Signer, lane: Lane, channelId: string,
): Promise<void> {
  const tags: string[][] = [["d", lane.repoId], ["name", lane.name], ["buzz-channel", channelId]];
  if (lane.description) tags.push(["description", lane.description]);
  if (lane.githubUrl) tags.push(["web", lane.githubUrl]);
  await relay.submit(signer.signEvent(K.KIND_REPO_ANNOUNCEMENT, tags, ""));
}

export async function fetchMyChannels(
  relay: Relay, myPubkey: string,
): Promise<{ uuid: string; name: string }[]> {
  const memberships = await relay.query([
    { kinds: [K.KIND_GROUP_MEMBERS], "#p": [myPubkey], limit: 200 },
  ]);
  const uuids = [...new Set(memberships.map((ev) => tagValue(ev, "d")).filter(Boolean))] as string[];
  if (!uuids.length) return [];
  const metas = await relay.query([{ kinds: [K.KIND_GROUP_METADATA], "#d": uuids, limit: 200 }]);
  return latestPerCoord(metas)
    .filter((ev) => !ev.tags.some((t) => t[0] === "hidden"))
    .flatMap((ev) => {
      const d = tagValue(ev, "d");
      return d ? [{ uuid: d, name: tagValue(ev, "name") ?? d.slice(0, 8) }] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
