# clawrouter-codex

**Let [OpenAI Codex](https://github.com/openai/codex) run on [ClawRouter](https://github.com/BlockRunAI/ClawRouter) — 55+ models, wallet-signed, x402 USDC micropayments, zero API keys.**

Codex only speaks the OpenAI **Responses API** (`/v1/responses`). ClawRouter speaks **Chat Completions** (`/v1/chat/completions`). This is a thin front-adapter that translates between them:

```
Codex ──/v1/responses──▶ [clawrouter-codex] ──/v1/chat/completions──▶ ClawRouter ──x402──▶ BlockRun
```

The bridge holds **no wallet and signs no payments**. Smart routing, x402 micropayments, and model fallback all stay in the canonical ClawRouter proxy — exactly like the Hermes adapter forwards to a spawned `npx @blockrun/clawrouter`. This process is pure wire-format translation, which keeps it a separate, independently-shippable package that never forks ClawRouter core.

## Quick start

```bash
# 1. Start the ClawRouter proxy (holds your wallet, pays via x402)
npx @blockrun/clawrouter        # listens on :8402

# 2. Start the bridge
npx @blockrun/clawrouter-codex  # listens on :8403, forwards to :8402

# 3. Point Codex at the bridge — ~/.codex/config.toml
```

```toml
model = "blockrun/auto"
model_provider = "clawrouter"

[model_providers.clawrouter]
name = "ClawRouter"
base_url = "http://localhost:8403/v1"
wire_api = "responses"
# no env_key needed — the wallet signature is the auth
```

## Run it as one always-on link

`npm start` brings up **both** the ClawRouter proxy and the bridge, health-checks
them, and supervises (restarts on exit). Safe to run repeatedly.

```bash
npm start                 # proxy (:8404) + bridge (:8403), uses your discovered wallet
```

To pay from a specific funded wallet that lives **outside** `~/.openclaw` (e.g. a
local `~/.blockrun` wallet), point at its key file and isolate HOME so a saved
`~/.openclaw` wallet can't shadow it:

```bash
WALLET_KEY_FILE=~/.blockrun/.session ISOLATE_HOME=1 npm start
```

### Keep it up across reboots (optional, macOS)

```bash
WALLET_KEY_FILE=~/.blockrun/.session ISOLATE_HOME=1 npm run install-daemon
npm run uninstall-daemon   # to remove
```

> ⚠️ The daemon auto-starts a **wallet-signing payment proxy** at login that can
> spend USDC unattended. Install it only on a machine you control and trust.

### Populate the model picker

```bash
npm run gen-catalog        # writes ~/.codex/clawrouter-catalog.json from the live model list
```

Then add `model_catalog_json = "~/.codex/clawrouter-catalog.json"` to `~/.codex/config.toml`.
For Codex **Desktop**, the picker only renders custom models when the provider has
`requires_openai_auth = true` (the bridge ignores the forwarded ChatGPT token and
still pays via the wallet).

## Web search (a switch)

Codex's built-in `web_search` is a *hosted* tool that only OpenAI's backend runs,
so it's silently dropped when routing through a custom provider. Instead the bridge
runs web search **itself** (BlockRun Exa, paid from your wallet): when a request
carries `x-web-search: 1`, the bridge offers a `web_search` tool, and when the model
calls it the bridge executes the Exa search, feeds the results back, and re-asks —
all invisibly to Codex. Works for every model.

```bash
npm run websearch on       # add x-web-search header to the clawrouter provider
npm run websearch off
npm run websearch status
# restart Codex to apply
```

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `PORT` | `8403` | Port the bridge listens on |
| `PROXY_PORT` | `8404` | Port `npm start` launches the ClawRouter proxy on |
| `CLAWROUTER_PROXY_URL` | `http://127.0.0.1:8404/v1` | Upstream the bridge forwards to |
| `CLAWROUTER_CMD` | `npx -y @blockrun/clawrouter` | Command `npm start` uses to launch the proxy |
| `WALLET_KEY_FILE` | — | Read the x402 wallet key from this file |
| `ISOLATE_HOME` | — | `1` = run the proxy under a fresh HOME so a saved wallet can't shadow the key |

## How the translation works

**Request** (`responsesToChat`): `instructions` → leading `system` message; `input[]` items → `messages[]` (`message`→`{role,content}`, `function_call`→assistant `tool_calls`, `function_call_output`→`{role:"tool", tool_call_id}`, `reasoning`→dropped); flat Responses `tools[]` → nested Chat tools. `stream` is forced to `false` upstream.

**Response** (`chatToResponsesEvents`): the single Chat Completion JSON becomes a Responses SSE sequence —
`response.created` → `response.output_text.delta` → `response.output_item.done` (a `message` item and/or `function_call` items) → `response.completed` (with `usage`). The last event is mandatory or Codex errors with *"stream closed before response.completed"*.

The exact SSE contract was read out of the Codex source (`codex-rs/codex-api/src/sse/responses.rs`): Codex parses each SSE `data:` JSON and dispatches on its `type` field.

## Limitations (v0.1)

- **Streaming is synthesized, not incremental.** ClawRouter buffers a full JSON completion internally, so output arrives as one delta. Protocol-correct; not yet token-by-token.
- **Reasoning items are dropped.** No encrypted-reasoning passthrough.
- **Stateless only.** Codex sends `store:false` with full `input` each turn, so no server-side `previous_response_id` state is needed.

## Tests

```bash
npm test     # node --test — zero dependencies
```

Covers request/response translation, flat→nested tool mapping, the multi-turn
`call_id` round-trip, and an end-to-end mock-upstream run asserting the SSE
satisfies Codex's parser contract.

## License

MIT © BlockRun
