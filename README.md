# clawrouter-codex

**Run [OpenAI Codex](https://github.com/openai/codex) on any [ClawRouter](https://github.com/BlockRunAI/ClawRouter) / BlockRun model — Claude, Gemini, DeepSeek, Kimi, GLM, Qwen, Grok, GPT and more — paid per request from a wallet (x402 USDC), no API keys.**

[![npm](https://img.shields.io/npm/v/@blockrun/clawrouter-codex?color=cb3837&logo=npm)](https://www.npmjs.com/package/@blockrun/clawrouter-codex)

Codex only speaks the OpenAI **Responses API** (`/v1/responses`). BlockRun speaks **Chat Completions**. This is a local bridge that translates between them and pays per request, so Codex (CLI, IDE, and Desktop) can use BlockRun's models:

```
Codex ──/v1/responses──▶ clawrouter-codex ──@blockrun/llm──▶ BlockRun   (x402 USDC, default)
```

By default the bridge pays BlockRun **directly** via the official [`@blockrun/llm`](https://www.npmjs.com/package/@blockrun/llm) SDK (plain per-request x402 on Base) — one process, no proxy, and the model list comes live from the source. It's wire-format translation plus a few conveniences (model picker, web search, a dashboard).

> **Two modes.** Direct (above) is the default. You can also run in **proxy mode** — forwarding to a local [`@blockrun/clawrouter`](https://github.com/BlockRunAI/ClawRouter) proxy that holds the wallet and adds smart routing — with `BRIDGE_MODE=proxy` (or by pointing `CLAWROUTER_PROXY_URL` at a running proxy).

---

## Quick start

You need [Node ≥ 20](https://nodejs.org) and a funded BlockRun wallet (`~/.blockrun/.session`, or set `BLOCKRUN_WALLET_KEY`). Then:

```bash
npx @blockrun/clawrouter-codex up       # start the bridge + write the Codex profile + build the catalog
codex --profile clawrouter              # use BlockRun models in the Codex CLI
```

That's it. `up` brings up the bridge (direct mode, `:8403`) and runs `setup` once it's healthy, then stays running. Want the models in **Codex Desktop's** picker too? Add:

```bash
npx @blockrun/clawrouter-codex desktop on   # restart Codex (Cmd+Q) after
```

`setup` writes a **profile** (`~/.codex/clawrouter.config.toml`), so your base config — and your ChatGPT-subscription default — is untouched: plain `codex` still uses it, `codex --profile clawrouter` uses BlockRun. (`start`, `setup`, `doctor` are still available as separate steps if you prefer.)

> No funded wallet yet? It still works — unfunded requests fall back to the free models. Fund USDC on Base to unlock the paid ones (the dashboard shows the address + a QR).

---

## Switches

```bash
npx @blockrun/clawrouter-codex desktop on     # show ClawRouter models in the Codex Desktop picker
npx @blockrun/clawrouter-codex websearch on   # enable live web search (BlockRun Exa, wallet-paid)
# …off to revert. Restart Codex (Cmd+Q) after toggling.
```

- **desktop** flips the *base* config so Codex Desktop (and plain `codex`) default to ClawRouter; `off` restores the native ChatGPT-subscription default. The CLI `--profile` works either way.
- **websearch** lets any model search the web. Codex's built-in `web_search` is a *hosted* tool that only OpenAI's backend runs, so the bridge runs web search itself (via BlockRun Exa) and feeds results back — transparently to Codex.

---

## Dashboard

```
http://localhost:8403/dashboard
```

A loopback panel: a master **Subscription ⇄ ClawRouter** switch, wallet balance + **Fund** (address QR + copy), 7-day spend, the web-search switch, and every model in your picker (click one to set it as the default, or **↻ Update models** to refresh after a ClawRouter release). Loopback-only — it reads wallet state and edits Codex config.

---

## Commands

| Command | What it does |
|---|---|
| `start` | Bring up the bridge (`:8403`) in **direct mode** — pays BlockRun via the SDK, no proxy — and supervise it |
| `setup` | Write the `clawrouter` profile and generate the model catalog |
| `doctor` | Verify the link end to end (bridge, mode, wallet, catalog, config) |
| `gen-catalog` | (Re)generate the model catalog from the live model list |
| `desktop on\|off` | Toggle the Codex Desktop picker between BlockRun and native GPT |
| `websearch on\|off` | Toggle live web search |
| `daemon` | Install a macOS LaunchAgent to keep the link up across reboots |
| `direct` | Run only the bridge in direct mode (what `start` uses) |
| `bridge` | Run only the bridge in **proxy mode** (forwards to a `@blockrun/clawrouter` proxy) |

Installed globally (`npm i -g @blockrun/clawrouter-codex`) the same commands are available as `clawrouter-codex <command>`.

### Codex config it writes

`setup` writes `~/.codex/clawrouter.config.toml` (a Codex *profile*, layered on top of your base config via `--profile clawrouter`):

```toml
model = "blockrun/auto"
model_provider = "clawrouter"
model_catalog_json = "~/.codex/clawrouter-catalog.json"

[model_providers.clawrouter]
name = "ClawRouter"
base_url = "http://localhost:8403/v1"
wire_api = "responses"
requires_openai_auth = false
```

> **Desktop note:** the Desktop picker only renders custom models when the provider has `requires_openai_auth = true` (a quirk of Codex's own UI). `desktop on` sets that on the base config; the bridge ignores the forwarded ChatGPT token and still pays via the wallet — it's never sent to OpenAI.

---

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `PORT` | `8403` | Port the bridge listens on |
| `BLOCKRUN_WALLET_KEY` | — | Raw `0x` EVM key for x402 (overrides `~/.blockrun/.session`) |
| `BLOCKRUN_DEFAULT_MODEL` | `anthropic/claude-opus-4.5` | Model that `blockrun/auto` resolves to in direct mode |
| `BLOCKRUN_API_URL` | `https://blockrun.ai/api` | BlockRun endpoint the SDK pays |
| **proxy mode only** | | |
| `BRIDGE_MODE=proxy` | — | Forward to a `@blockrun/clawrouter` proxy instead of paying directly |
| `PROXY_PORT` | `8404` | Port `start` launches the proxy on (proxy mode) |
| `CLAWROUTER_PROXY_URL` | `http://127.0.0.1:8404/v1` | Proxy upstream to forward to (also enables proxy mode) |
| `CLAWROUTER_CMD` | `npx -y @blockrun/clawrouter@latest` | Command `start` uses to launch the proxy |

`start` auto-discovers `~/.blockrun/.session`; on most machines no wallet env is needed.

### Keep it up across reboots (macOS)

```bash
npx @blockrun/clawrouter-codex daemon          # install a login LaunchAgent
npx @blockrun/clawrouter-codex daemon uninstall
```

> ⚠️ The daemon auto-starts a wallet-signing payment proxy at login that can spend USDC unattended. Install it only on a machine you control.

---

## How the translation works

**Request** (`responsesToChat`): `instructions` → leading `system` message; `input[]` items → `messages[]` (`message`→`{role,content}`, `function_call`→assistant `tool_calls`, `function_call_output`→`{role:"tool", tool_call_id}`, `reasoning`→dropped); flat Responses `tools[]` → nested Chat tools.

**Response** (`chatToResponsesEvents`): the buffered Chat Completion becomes a Responses SSE sequence — `response.created` → `response.output_item.added` → `response.output_text.delta` → `response.output_item.done` (message and/or `function_call` items) → `response.completed`. Tool calls a model leaks as raw JSON in text are recovered and re-emitted as structured `function_call`s.

The exact SSE contract was read from the Codex source (`codex-rs/codex-api/src/sse/responses.rs`).

## Limitations

- **Streaming is synthesized, not incremental** — output arrives as one delta (protocol-correct, not yet token-by-token).
- **Reasoning items are dropped** — no encrypted-reasoning passthrough.
- **Stateless** — Codex sends `store:false` with full `input` each turn, so no server-side response state is needed.

## Tests

```bash
npm test     # node --test, zero dependencies
```

## License

MIT © BlockRun
