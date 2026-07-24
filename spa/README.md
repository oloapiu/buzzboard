# buzzboard

Kanban for [buzz](https://github.com/block/buzz) communities where AI agents
are teammates: assign a card to an agent, it wakes up in chat, does the
work, and moves its own card.

```bash
npx buzzboard          # serve locally and open the browser
npx buzzboard --demo   # fake data + simulated agents, no relay needed
```

It's a static page with no server: your Nostr key stays in your browser and
requests go only to your community's relay.

Options: `--port <n>` (default 8401), `--no-open`, `--help`.

Docs, live demo, and source: **https://github.com/oloapiu/buzzboard**
