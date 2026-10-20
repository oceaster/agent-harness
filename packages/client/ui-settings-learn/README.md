# @deepseek-ai/dsh-client-ui-settings-learn

English | [中文](README.zh.md)

This household deployment plugin owns the Settings modal's **Learn More** tab. It explains, per agent the signed-in person may use, what that agent is for, how it works, what it will not do and how to work with it — a compressed reference sheet rather than a marketing page.

The words are not the plugin's. e-server serves them from `context/agent-guides.json` at `GET /v1/browser/learn`, on the same origin that serves this page and at the origin root (never under the page's `/_dsh/` prefix). The profile cookie is the whole authentication, so the plugin sends no identity and holds no agent id, agent name, section id or sentence of guide prose: whatever the server sends is what the tab renders, in the server's order. Editing a guide is therefore an e-server content change and needs no browser rebuild.

## The wire

```json
{
  "person": { "id": "owen", "name": "Owen" },
  "agents": [
    {
      "agent": "delta",
      "name": "Delta",
      "enabled": true,
      "summary": "…",
      "sections": [{ "id": "what-it-is-for", "title": "…", "body": "…\n\n…" }]
    }
  ]
}
```

`sections[].body` is plain text with a blank line between paragraphs — no markdown, no HTML — and each paragraph is rendered as its own `<p>`. The section list is open: the agents carry different last sections (Delta's waiting/workers block, Darwin's handoff block, Diana's memory block), and the tab renders whatever arrives rather than a fixed set it knows by name.

A payload that breaks the shape (an agent or a section missing a required field) is refused as a malformed answer and shown as a failure. Dropping or adding whole sections on the server is not a break: the tab follows.

## States

Four states, each its own screen:

| State | When | Screen |
| --- | --- | --- |
| loading | the read is in flight | one loading line |
| ready | 200 with agents | the sheet |
| ready, empty | 200 with `"agents": []` | "No guides for this profile" |
| error | any other non-2xx, or a malformed body | the server's own sentence plus a retry |
| refused | 403 | the refusal, with no retry |

An empty roster and a refusal mean different things and are never rendered as each other: `agents: []` is a policy answer about a real signed-in person ("this profile may open no agent"), while a 403 is the deployment refusing the profile, which on this deployment happens before the learn route runs at all (Guest answers `{"detail": "DSH is unavailable to Guest"}`).

Failures read `body.detail`, which FastAPI wraps: a string for `HTTPException(500, "…")` and an object for `HTTPException(502, {error, code, message})`. That sentence is the useful thing on screen — e-server names the agent whose guide is missing, or says the harness is restarting — so it is shown verbatim, and the dictionary's per-code copy is used only when the body carried no readable sentence. A retry re-requests and, if it fails again, shows the second failure; it never claims success.

## Layout

The section fills the settings panel's content column and scrolls with it. Each agent is one dense block — name, summary, then a section per labelled row — with a rule between agents instead of a card per agent. A section row puts its heading in a narrow left column beside its prose and stacks to a single column below a 760px viewport, where the panel is too narrow to seat both. Text seats wrap long words and both grid tracks may shrink to zero, so the panel never gains a horizontal scrollbar at any width.

## Extension points

The plugin registers one `settings.section` entry (`id: learn`, `order: 5`, between General and Plugins) and reads nothing else. Its inject face publishes the controller snapshot through the reserved `hooks` compartment (bound as `useLearn`) plus one `load` callback; the component renders only those props. It leaves with its fiber, so a plugin reload removes the tab and its dictionaries.

The read starts on the tab's first render, not at plugin load: a person who never opens Learn More costs no request.

## Model Experience

None, as a settings page that renders server-served prose registers no model context and writes no session event.

#### KV Cache effect

None; this browser plugin neither assembles provider requests nor writes session events.

## Known Limitations and Deferred Work

- Requires the household e-server origin to serve `GET /v1/browser/learn`. A deployment without it shows a failure naming the 404 rather than an empty tab.
- The guides are read once per page load. An edit to the server's guides appears after a reload (or on a retry from a failed read); there is no polling and no live refresh.
- Which agents appear is decided entirely by the server's roster ∩ composed-presets rule; the plugin cannot be used to show a guide to an agent the server did not include.
- The composed browser surface is verified by the coordinator's post-merge gate against the real origin; this package's suite proves the wire parsing, the controller states and the rendered sheet against the real payload, not the deployed page.
