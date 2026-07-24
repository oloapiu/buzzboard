// Demo mode (?demo): the full app running against an in-memory event store.
// Nothing leaves the browser. The "agents" are a scripted simulation that
// appends real signed status events on a timer — the normal poll + derivation
// pipeline does the rest, exactly as it would with live agents.

import * as K from "./kinds.ts";
import { hexToBytes, Signer, type SignedEvent } from "./nostr.ts";

const key = (n: string) => new Signer(hexToBytes(n.padStart(64, "0")));

export const demoSigner = key("05");
const bumble = key("11");
const fizz = key("12");
const honey = key("13");

const CH_PAYMENTS = "aaaaaaaa-0000-4000-8000-000000000001";
const CH_MOBILE = "aaaaaaaa-0000-4000-8000-000000000002";
const CH_OPS = "aaaaaaaa-0000-4000-8000-000000000003";

let seq = 0;
const fx = (
  kind: number, pubkey: string, created_at: number, tags: string[][], content = "",
): SignedEvent =>
  ({
    id: `de${(++seq).toString(16).padStart(62, "0")}`,
    kind, pubkey, created_at, tags, content, sig: "0".repeat(128),
  }) as SignedEvent;

export class DemoRelay {
  constructor(public events: SignedEvent[]) {}

  async query(filters: Record<string, unknown>[]): Promise<SignedEvent[]> {
    const out: SignedEvent[] = [];
    for (const f of filters) {
      for (const e of this.events) {
        if (out.includes(e)) continue;
        if (Array.isArray(f.kinds) && !(f.kinds as number[]).includes(e.kind)) continue;
        if (Array.isArray(f.authors) && !(f.authors as string[]).includes(e.pubkey)) continue;
        if (Array.isArray(f.ids) && !(f.ids as string[]).includes(e.id)) continue;
        let ok = true;
        for (const [k, want] of Object.entries(f)) {
          if (!k.startsWith("#")) continue;
          const have = e.tags.filter((t) => t[0] === k.slice(1)).map((t) => t[1]);
          if (!(want as string[]).some((v) => have.includes(v))) ok = false;
        }
        if (ok) out.push(e);
      }
    }
    return out;
  }

  async submit(event: SignedEvent) {
    this.events.push(event);
    return {};
  }
}

function buildDemoEvents(now: number): { events: SignedEvent[]; simIssueId: string } {
  const me = demoSigner.pubkey;
  const lane = (d: string) => `30617:${me}:${d}`;
  const events: SignedEvent[] = [];

  // profiles + managed agents
  const roster: [Signer, string][] = [[bumble, "Bumble"], [fizz, "Fizz"], [honey, "Honey"]];
  events.push(fx(0, me, now - 9000, [], JSON.stringify({ name: "Ada" })));
  for (const [agent, name] of roster) {
    events.push(fx(0, agent.pubkey, now - 9000, [["auth", me, "", "sig"]], JSON.stringify({ name })));
    events.push(fx(K.KIND_MANAGED_AGENT, me, now - 9000, [["d", agent.pubkey]], JSON.stringify({ name })));
  }

  // lanes + channel rosters
  events.push(fx(K.KIND_REPO_ANNOUNCEMENT, me, now - 8000, [
    ["d", "payments"], ["name", "Payments"], ["description", "Billing, invoicing, refunds"],
    ["buzz-channel", CH_PAYMENTS], ["web", "https://github.com/acme/payments"],
    ["clone", "https://github.com/acme/payments.git"], ["sync-agent", honey.pubkey],
  ]));
  events.push(fx(K.KIND_REPO_ANNOUNCEMENT, me, now - 8000, [
    ["d", "mobile-app"], ["name", "Mobile app"], ["description", "iOS & Android client"],
    ["buzz-channel", CH_MOBILE],
  ]));
  events.push(fx(K.KIND_REPO_ANNOUNCEMENT, me, now - 8000, [
    ["d", "ops"], ["name", "Ops"], ["description", "Infra & on-call"],
    ["buzz-channel", CH_OPS],
  ]));
  for (const ch of [CH_PAYMENTS, CH_MOBILE, CH_OPS]) {
    events.push(fx(K.KIND_GROUP_MEMBERS, me, now - 8000, [
      ["d", ch], ["p", me, "", "owner"],
      ...roster.map(([a]) => ["p", a.pubkey, "", "bot"]),
    ]));
  }

  const card = (
    laneD: string, subject: string, at: number, labels: string[] = [], body = "",
  ): SignedEvent => {
    const ev = fx(K.KIND_GIT_ISSUE, me, at,
      [["a", lane(laneD)], ["p", me], ["subject", subject], ...labels.map((l) => ["t", l])],
      body);
    events.push(ev);
    return ev;
  };
  const status = (
    issue: SignedEvent, laneD: string, kind: number, at: number,
    by: Signer | null, extra: string[][] = [], content = "",
  ) => {
    events.push(fx(kind, (by ?? demoSigner).pubkey, at,
      [["e", issue.id, "", "root"], ["a", lane(laneD)], ...extra], content));
  };
  const dispatch = (laneCh: string, agent: Signer, issue: SignedEvent, at: number) => {
    const msg = fx(K.KIND_STREAM_MESSAGE, me, at, [["h", laneCh], ["p", agent.pubkey]],
      `you've been assigned: ${issue.tags.find((t) => t[0] === "subject")?.[1]}`);
    events.push(msg);
    return ["dispatch", msg.id, laneCh];
  };

  // --- Payments ---
  const sim = card("payments", "Rate-limit webhook retries", now - 7000, ["backend"],
    "Retries hammer the payment provider when it's already down. Add exponential backoff with jitter, cap at 6 attempts.");
  status(sim, "payments", K.KIND_STATUS_OPEN, now - 6900, null,
    [["assignee", bumble.pubkey], ["rank", "i"], dispatch(CH_PAYMENTS, bumble, sim, now - 6950)]);

  const blocked = card("payments", "Refund flow returns 500 on partial capture", now - 7100, ["bug"],
    "Repro: capture 40% of an auth, then refund the rest. The refund endpoint 500s.");
  status(blocked, "payments", K.KIND_STATUS_OPEN, now - 7000, null,
    [["assignee", fizz.pubkey], ["rank", "r"], dispatch(CH_PAYMENTS, fizz, blocked, now - 7050)]);
  status(blocked, "payments", K.KIND_STATUS_DRAFT, now - 5000, fizz);

  const synced = card("payments", "Reconcile provider payouts nightly", now - 7200, ["backend"]);
  status(synced, "payments", K.KIND_STATUS_OPEN, now - 7100, null,
    [["assignee", honey.pubkey], ["rank", "x"], dispatch(CH_PAYMENTS, honey, synced, now - 7150)]);
  status(synced, "payments", K.KIND_STATUS_RESOLVED, now - 4000, honey, [],
    "Done — nightly job in place. GitHub: https://github.com/acme/payments/issues/42");

  const doneCard = card("payments", "Migrate billing webhooks to v2", now - 8600, []);
  status(doneCard, "payments", K.KIND_STATUS_RESOLVED, now - 6000, null);
  card("payments", "Chargeback email templates", now - 6500, ["design"]);

  // --- Mobile app ---
  const push = card("mobile-app", "Push notifications for blocked cards", now - 7300, ["feature"]);
  status(push, "mobile-app", K.KIND_STATUS_OPEN, now - 7200, null,
    [["assignee", bumble.pubkey], ["rank", "i"], dispatch(CH_MOBILE, bumble, push, now - 7250)]);
  status(push, "mobile-app", K.KIND_STATUS_OPEN, now - 3000, bumble);
  card("mobile-app", "Offline queue for card drags", now - 6200, ["feature"]);
  const icon = card("mobile-app", "App icon dark-mode variant", now - 8000, ["design"]);
  status(icon, "mobile-app", K.KIND_STATUS_RESOLVED, now - 5500, null);

  // --- Ops ---
  const certs = card("ops", "Rotate relay TLS certificates", now - 6000, []);
  status(certs, "ops", K.KIND_STATUS_DRAFT, now - 5900, null);
  const alerting = card("ops", "Alert when the sync agent falls behind", now - 6400, ["monitoring"]);
  status(alerting, "ops", K.KIND_STATUS_OPEN, now - 6300, null,
    [["assignee", honey.pubkey], ["rank", "i"]]);

  return { events, simIssueId: sim.id };
}

/** Bumble works the sim card: Backlog -> In Progress -> In Review -> reset. */
function startSimulation(relay: DemoRelay, simIssueId: string) {
  let phase = 0;
  const mine: SignedEvent[] = [];
  setInterval(() => {
    const laneAddr = `30617:${demoSigner.pubkey}:payments`;
    if (phase === 0) {
      const ev = bumble.signEvent(K.KIND_STATUS_OPEN,
        [["e", simIssueId, "", "root"], ["a", laneAddr]], "Claimed — starting on the backoff logic.");
      mine.push(ev);
      relay.events.push(ev);
    } else if (phase === 1) {
      const ev = bumble.signEvent(K.KIND_STATUS_RESOLVED,
        [["e", simIssueId, "", "root"], ["a", laneAddr]], "Backoff + jitter implemented, tests added.");
      mine.push(ev);
      relay.events.push(ev);
    } else {
      relay.events = relay.events.filter((e) => !mine.includes(e));
      mine.length = 0;
    }
    phase = (phase + 1) % 3;
  }, 8000);
}

let singleton: DemoRelay | null = null;

export function getDemoRelay(): DemoRelay {
  if (!singleton) {
    const { events, simIssueId } = buildDemoEvents(Math.floor(Date.now() / 1000));
    singleton = new DemoRelay(events);
    startSimulation(singleton, simIssueId);
  }
  return singleton;
}
