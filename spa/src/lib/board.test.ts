import { describe, expect, it } from "vitest";
import {
  assignCard, attachChannel, boardCanvasBlock, cardOrder, createCard, createLane,
  fetchBoard, githubSlug, mergeBoardBlock, moveCard, type Card, type Lane,
} from "./board.ts";
import { parsePrivateKey, Signer, type SignedEvent } from "./nostr.ts";

// --- fixtures ---

const OWNER = "a".repeat(64);
const AGENT = "b".repeat(64);
const SYNC = "c".repeat(64);
const STRANGER = "d".repeat(64);
const CHANNEL = "11111111-2222-3333-4444-555555555555";
const ADDR = `30617:${OWNER}:widgets`;

let seq = 0;
const nextId = () => (++seq).toString(16).padStart(64, "0");

function ev(
  kind: number, pubkey: string, created_at: number,
  tags: string[][], content = "",
): SignedEvent {
  return { id: nextId(), kind, pubkey, created_at, tags, content, sig: "0".repeat(128) } as SignedEvent;
}

const laneEvent = (extraTags: string[][] = [], created_at = 10) =>
  ev(30617, OWNER, created_at, [["d", "widgets"], ["name", "Widgets"], ...extraTags]);

const issueEvent = (opts: { pubkey?: string; labels?: string[]; created_at?: number } = {}) =>
  ev(1621, opts.pubkey ?? OWNER, opts.created_at ?? 100,
    [["a", ADDR], ["subject", "Fix login"], ...(opts.labels ?? []).map((l) => ["t", l])],
    "body");

/** Status event; `noA` mimics `buzz issues status` run without repo flags. */
function statusEvent(
  kind: number, pubkey: string, created_at: number, issueId: string,
  opts: { tags?: string[][]; content?: string; noA?: boolean } = {},
): SignedEvent {
  const tags = [["e", issueId, "", "root"], ...(opts.noA ? [] : [["a", ADDR]]), ...(opts.tags ?? [])];
  return ev(kind, pubkey, created_at, tags, opts.content ?? "");
}

/** In-memory relay implementing the filter subset the board uses. */
class StubRelay {
  submitted: SignedEvent[] = [];
  constructor(public events: SignedEvent[] = []) {}

  async query(filters: Record<string, unknown>[]): Promise<SignedEvent[]> {
    const out: SignedEvent[] = [];
    for (const f of filters) {
      for (const e of this.events) {
        if (out.includes(e)) continue;
        if (Array.isArray(f.kinds) && !(f.kinds as number[]).includes(e.kind)) continue;
        if (Array.isArray(f.authors) && !(f.authors as string[]).includes(e.pubkey)) continue;
        if (Array.isArray(f.ids) && !(f.ids as string[]).includes(e.id)) continue;
        let tagsOk = true;
        for (const [key, want] of Object.entries(f)) {
          if (!key.startsWith("#")) continue;
          const name = key.slice(1);
          const have = e.tags.filter((t) => t[0] === name).map((t) => t[1]);
          if (!(want as string[]).some((v) => have.includes(v))) tagsOk = false;
        }
        if (tagsOk) out.push(e);
      }
    }
    return out;
  }

  async submit(event: SignedEvent) {
    this.submitted.push(event);
    return {};
  }
}

const signer = new Signer(parsePrivateKey(
  "0000000000000000000000000000000000000000000000000000000000000003",
));

async function boardWith(events: SignedEvent[], me = OWNER) {
  const relay = new StubRelay(events);
  const data = await fetchBoard(relay as never, me);
  return { relay, data, cards: data.cards.get(ADDR) ?? [] };
}

// --- lane parsing ---

describe("lane parsing", () => {
  it("reads channel, github, and sync-agent bindings from tags", async () => {
    const { data } = await boardWith([laneEvent([
      ["buzz-channel", CHANNEL],
      ["web", "https://github.com/acme/widgets"],
      ["sync-agent", SYNC],
      ["description", "widget work"],
    ])]);
    expect(data.lanes).toHaveLength(1);
    const lane = data.lanes[0];
    expect(lane.address).toBe(ADDR);
    expect(lane.channelId).toBe(CHANNEL);
    expect(lane.githubUrl).toBe("https://github.com/acme/widgets");
    expect(lane.syncAgent).toBe(SYNC);
    expect(lane.description).toBe("widget work");
  });

  it("keeps only the newest announcement per (owner, d) coordinate", async () => {
    const { data } = await boardWith([
      laneEvent([["description", "old"]], 10),
      laneEvent([["description", "new"]], 20),
    ]);
    expect(data.lanes).toHaveLength(1);
    expect(data.lanes[0].description).toBe("new");
  });
});

// --- column derivation ---

describe("column derivation", () => {
  it("defaults to backlog; issue labels override", async () => {
    let r = await boardWith([laneEvent(), issueEvent()]);
    expect(r.cards[0].column).toBe("backlog");
    r = await boardWith([laneEvent(), issueEvent({ labels: ["in-progress"] })]);
    expect(r.cards[0].column).toBe("in_progress");
    r = await boardWith([laneEvent(), issueEvent({ labels: ["review"] })]);
    expect(r.cards[0].column).toBe("in_review");
    r = await boardWith([laneEvent(), issueEvent({ labels: ["triage"] })]);
    expect(r.cards[0].column).toBe("triage");
  });

  it("maps owner status kinds like the buzz desktop", async () => {
    const issue = issueEvent();
    const cases: [number, string][] = [[1631, "done"], [1632, "closed"], [1633, "triage"]];
    for (const [kind, col] of cases) {
      const { cards } = await boardWith([laneEvent(), issue, statusEvent(kind, OWNER, 200, issue.id)]);
      expect(cards[0].column).toBe(col);
    }
  });

  it("honors labels on the latest status event (board extension)", async () => {
    const issue = issueEvent();
    const { cards } = await boardWith([
      laneEvent(), issue,
      statusEvent(1630, OWNER, 200, issue.id, { tags: [["t", "in-review"]] }),
    ]);
    expect(cards[0].column).toBe("in_review");
  });

  it("an explicit open status supersedes creation-time issue labels", async () => {
    const issue = issueEvent({ labels: ["triage"] });
    // no status yet: the triage label parks it in Triage (intake gate)
    let r = await boardWith([laneEvent(), issue]);
    expect(r.cards[0].column).toBe("triage");
    // a human accepts it by moving to Backlog — the label must not pull it back
    r = await boardWith([laneEvent(), issue, statusEvent(1630, OWNER, 200, issue.id)]);
    expect(r.cards[0].column).toBe("backlog");
  });

  it("ignores status events from strangers", async () => {
    const issue = issueEvent();
    const { cards } = await boardWith([
      laneEvent(), issue, statusEvent(1631, STRANGER, 200, issue.id),
    ]);
    expect(cards[0].column).toBe("backlog");
  });

  it("newest counted status wins", async () => {
    const issue = issueEvent();
    const { cards } = await boardWith([
      laneEvent(), issue,
      statusEvent(1631, OWNER, 200, issue.id),
      statusEvent(1633, OWNER, 300, issue.id),
    ]);
    expect(cards[0].column).toBe("triage");
  });
});

describe("assignee lifecycle", () => {
  const issue = issueEvent();
  const assign = statusEvent(1630, OWNER, 150, issue.id, { tags: [["assignee", AGENT]] });

  it("derives assignee from the newest tag by any member", async () => {
    const { cards } = await boardWith([laneEvent(), issue, assign]);
    expect(cards[0].assignee).toBe(AGENT);
  });

  it("assignee open -> in_progress, resolved -> in_review, draft -> in_review + blocked", async () => {
    let r = await boardWith([laneEvent(), issue, assign, statusEvent(1630, AGENT, 200, issue.id, { noA: true })]);
    expect(r.cards[0].column).toBe("in_progress");
    expect(r.cards[0].blocked).toBe(false);

    r = await boardWith([laneEvent(), issue, assign, statusEvent(1631, AGENT, 200, issue.id, { noA: true })]);
    expect(r.cards[0].column).toBe("in_review");
    expect(r.cards[0].blocked).toBe(false);

    r = await boardWith([laneEvent(), issue, assign, statusEvent(1633, AGENT, 200, issue.id, { noA: true })]);
    expect(r.cards[0].column).toBe("in_review");
    expect(r.cards[0].blocked).toBe(true);
  });

  it("owner resolved still means done, and human recovery outranks agent draft", async () => {
    let r = await boardWith([laneEvent(), issue, assign, statusEvent(1631, OWNER, 200, issue.id)]);
    expect(r.cards[0].column).toBe("done");

    r = await boardWith([
      laneEvent(), issue, assign,
      statusEvent(1633, AGENT, 200, issue.id, { noA: true }),
      statusEvent(1630, OWNER, 300, issue.id),
    ]);
    expect(r.cards[0].column).toBe("backlog");
    expect(r.cards[0].blocked).toBe(false);
  });

  it("statuses reachable only via #e (no repo tag) still count", async () => {
    const { cards } = await boardWith([
      laneEvent(), issue, assign,
      statusEvent(1631, AGENT, 200, issue.id, { noA: true }),
    ]);
    expect(cards[0].column).toBe("in_review");
  });
});

describe("sync agent", () => {
  const lane = laneEvent([
    ["buzz-channel", CHANNEL],
    ["web", "https://github.com/acme/widgets"],
    ["sync-agent", SYNC],
  ]);
  const issue = issueEvent();

  it("is a strict status actor and its GitHub cross-link is extracted", async () => {
    const { cards } = await boardWith([
      lane, issue,
      statusEvent(1631, SYNC, 200, issue.id, {
        content: "GitHub: https://github.com/acme/widgets/issues/7",
      }),
    ]);
    expect(cards[0].column).toBe("done");
    expect(cards[0].githubIssueUrl).toBe("https://github.com/acme/widgets/issues/7");
  });
});

describe("rank / dispatch derivation and ordering", () => {
  it("reads rank and dispatch pointer from any member's newest tagged status", async () => {
    const issue = issueEvent();
    const { cards } = await boardWith([
      laneEvent(), issue,
      statusEvent(1630, STRANGER, 200, issue.id, {
        tags: [["rank", "i"], ["dispatch", "9".repeat(64), CHANNEL]],
      }),
    ]);
    expect(cards[0].rank).toBe("i");
    expect(cards[0].threadLink).toBe(`buzz://message?channel=${CHANNEL}&id=${"9".repeat(64)}`);
    expect(cards[0].column).toBe("backlog"); // stranger's event never moves the column
  });

  it("orders ranked cards first, then unranked by recency", () => {
    const mk = (rank: string | null, updatedAt: number) =>
      ({ rank, updatedAt } as Card);
    const sorted = [mk(null, 300), mk("m", 1), mk("a", 2), mk(null, 500)].sort(cardOrder);
    expect(sorted.map((c) => c.rank)).toEqual(["a", "m", null, null]);
    expect(sorted[2].updatedAt).toBe(500);
  });
});

// --- pure helpers ---

describe("githubSlug", () => {
  it("extracts owner/repo and rejects non-github urls", () => {
    expect(githubSlug("https://github.com/acme/widgets")).toBe("acme/widgets");
    expect(githubSlug("https://github.com/acme/widgets.git")).toBe("acme/widgets");
    expect(githubSlug("https://github.com/acme/widgets/issues?q=1")).toBe("acme/widgets");
    expect(githubSlug("https://gitlab.com/acme/widgets")).toBeNull();
    expect(githubSlug("nonsense")).toBeNull();
  });
});

describe("canvas board block", () => {
  const block = (url: string) => boardCanvasBlock(url, OWNER, "widgets");
  const url = "http://localhost:8401/#lane-widgets";

  it("teaches agents the triage-labelled create command", () => {
    const b = block(url);
    expect(b).toContain(`--repo-owner ${OWNER} --repo-id widgets`);
    expect(b).toContain("--label triage");
    expect(b).toContain(`[Open buzzboard](${url})`);
  });

  it("appends without clobbering, idempotently, replacing only its own block", () => {
    const fresh = mergeBoardBlock("", block(url));
    expect(fresh).toContain("[Open buzzboard]");
    const appended = mergeBoardBlock("# Notes\n\nImportant.", block(url));
    expect(appended.startsWith("# Notes\n\nImportant.")).toBe(true);
    expect(mergeBoardBlock(appended, block(url))).toBe(appended);
    const moved = mergeBoardBlock(appended, block("http://localhost:9999/x"));
    expect(moved).toContain("Important.");
    expect(moved).toContain(":9999");
    expect(moved).not.toContain(":8401");
    expect(moved.split("Open buzzboard")).toHaveLength(2);
  });

  it("upgrades a legacy single-line link in place", () => {
    const legacy = "# Notes\n\n📋 [Open buzzboard](http://old.example)\n\nMore notes.";
    const upgraded = mergeBoardBlock(legacy, block(url));
    expect(upgraded).toContain("More notes.");
    expect(upgraded).not.toContain("old.example");
    expect(upgraded).toContain("--label triage");
    expect(upgraded.split("Open buzzboard")).toHaveLength(2);
  });
});

// --- action builders ---

const lane: Lane = {
  address: ADDR, owner: OWNER, repoId: "widgets", name: "Widgets", description: "",
  channelId: CHANNEL, githubUrl: "https://github.com/acme/widgets", syncAgent: null,
};
const card: Card = {
  id: "e".repeat(64), subject: "Fix login", body: "", labels: [], author: OWNER,
  createdAt: 1, updatedAt: 1, column: "backlog", blocked: false, rank: null,
  assignee: null, threadLink: null, githubIssueUrl: null,
};
const tagsOf = (e: SignedEvent, name: string) =>
  e.tags.filter((t) => t[0] === name).map((t) => t.slice(1));

describe("actions", () => {
  it("moveCard publishes the right status kind, labels, anchor tags, and a rank", async () => {
    const relay = new StubRelay();
    await moveCard(relay as never, signer, lane, card, "in_review", { before: null, after: null });
    const [e] = relay.submitted;
    expect(e.kind).toBe(1630);
    expect(tagsOf(e, "t").flat()).toContain("in-review");
    expect(e.tags).toContainEqual(["e", card.id, "", "root"]);
    expect(e.tags).toContainEqual(["a", ADDR]);
    expect(e.tags).toContainEqual(["p", OWNER]);
    expect(tagsOf(e, "rank")).toHaveLength(1);
  });

  it("assignCard publishes dispatch mention then status with assignee + dispatch tags", async () => {
    const relay = new StubRelay();
    await assignCard(relay as never, signer, lane, card, AGENT, "codey", true, "paolo");
    expect(relay.submitted.map((e) => e.kind)).toEqual([9, 1630]);
    const [msg, status] = relay.submitted;
    expect(msg.tags).toContainEqual(["h", CHANNEL]);
    expect(msg.tags).toContainEqual(["p", AGENT]);
    expect(msg.content).toContain("@codey");
    expect(msg.content).toContain(card.id);
    expect(status.tags).toContainEqual(["assignee", AGENT]);
    expect(status.tags).toContainEqual(["dispatch", msg.id, CHANNEL]);
  });

  it("assignCard without a lane channel publishes only the assignee status", async () => {
    const relay = new StubRelay();
    await assignCard(relay as never, signer, { ...lane, channelId: null }, card, AGENT, "codey", true, "paolo");
    expect(relay.submitted.map((e) => e.kind)).toEqual([1630]);
    expect(relay.submitted[0].tags.some((t) => t[0] === "dispatch")).toBe(false);
  });

  it("createCard in a synced lane also posts a mirror request to the sync agent", async () => {
    const relay = new StubRelay();
    await createCard(relay as never, signer, { ...lane, syncAgent: SYNC }, "New", "body", ["bug"], "syncy");
    expect(relay.submitted.map((e) => e.kind)).toEqual([1621, 9]);
    const [issue, msg] = relay.submitted;
    expect(issue.tags).toContainEqual(["t", "bug"]);
    expect(msg.tags).toContainEqual(["p", SYNC]);
    expect(msg.content).toContain(issue.id);
    expect(msg.content).toContain("acme/widgets");
  });

  it("createCard in an unsynced lane publishes only the issue", async () => {
    const relay = new StubRelay();
    await createCard(relay as never, signer, lane, "New", "", []);
    expect(relay.submitted.map((e) => e.kind)).toEqual([1621]);
  });

  it("createLane publishes channel, memberships, canvas link, announcement, sync brief", async () => {
    const relay = new StubRelay();
    await createLane(relay as never, signer, "My Lane!", "desc",
      "https://github.com/acme/widgets", [AGENT], null, "http://localhost:8401", SYNC, "syncy");
    expect(relay.submitted.map((e) => e.kind)).toEqual([9007, 9000, 40100, 30617, 9]);
    const [create, member, canvas, ann, brief] = relay.submitted;
    const channelId = create.tags.find((t) => t[0] === "h")![1];
    expect(member.tags).toContainEqual(["p", AGENT]);
    expect(member.tags).toContainEqual(["role", "bot"]);
    expect(canvas.content).toContain("#lane-my-lane");
    expect(canvas.content).toContain("--label triage"); // agents learn the filing command
    expect(ann.tags).toContainEqual(["d", "my-lane"]); // slugified
    expect(ann.tags).toContainEqual(["buzz-channel", channelId]);
    expect(ann.tags).toContainEqual(["web", "https://github.com/acme/widgets"]);
    expect(ann.tags).toContainEqual(["sync-agent", SYNC]);
    expect(brief.tags).toContainEqual(["p", SYNC]);
    expect(brief.content).toContain("acme/widgets");
    expect(brief.content).toContain("sync agent");
  });

  it("attachChannel preserves existing lane bindings", async () => {
    const relay = new StubRelay();
    await attachChannel(relay as never, signer,
      { ...lane, syncAgent: SYNC, channelId: null }, CHANNEL);
    const [ann] = relay.submitted;
    expect(ann.kind).toBe(30617);
    expect(ann.tags).toContainEqual(["buzz-channel", CHANNEL]);
    expect(ann.tags).toContainEqual(["web", lane.githubUrl!]);
    expect(ann.tags).toContainEqual(["sync-agent", SYNC]);
  });
});
