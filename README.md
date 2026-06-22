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

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `PORT` | `8403` | Port the bridge listens on |
| `CLAWROUTER_PROXY_URL` | `http://127.0.0.1:8402/v1` | The ClawRouter proxy's OpenAI base URL |

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
