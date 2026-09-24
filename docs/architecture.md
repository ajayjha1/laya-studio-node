# Architecture

## The one seam that touches the network

```text
Your application
      │
      ▼
 Laya (client)          predict()  ← canonical, raw passthrough
      │                   └─ classify · decide · score · screen · match · batch
      │                      (convenience wrappers: types + ergonomics)
      │
      ├── decisions/    spec → Laya question;  answer → typed result
      ├── router/       confidence-gated dispatch to registered handlers
      ├── cache/        LayaCache interface + in-memory store
      ├── hooks/        metadata-only observability
      ├── errors/       five typed, actionable errors
      │
      ▼
 LayaTransport          ← the only thing that knows about HTTP
      │
      ▼
 POST /v1/systemone
 GET  /health
      │
      ▼
 laya-serve (or any compatible endpoint)
```

`predict()` takes Laya's questions verbatim and returns its answers verbatim.
Every convenience method compiles a spec into those same questions and maps the
answers back into a typed result — so there is exactly one code path to the
network, and the wrappers can never drift from it on caching, hooks, retries or
limit checks.

Everything above `LayaTransport` is network-agnostic. That is what makes the
test suite able to run the whole SDK against an in-process fake, and what makes
a future hosted Laya a configuration change rather than a rewrite.

## The wire contract

Taken from Laya's own server implementation
([`laya/serve.py`](https://github.com/NandhaKishorM/laya/blob/main/laya/serve.py))
and answer construction
([`laya/agent.py`](https://github.com/NandhaKishorM/laya/blob/main/laya/agent.py)).
Nothing in this package was invented.

### `POST /v1/systemone`

```jsonc
// request
{
  "state": "My payment failed",     // string, object, or array
  "questions": {
    "intent": {
      "type": "choice",
      "instructions": "Which department should handle this?",
      "criteria": { "billing": "invoices, refunds", "technical": "bugs" }
    }
  },
  "model": "english"                // optional; otherwise the server auto-routes
}
```

```jsonc
// response
{
  "model": "laya-rl-agent",
  "answers": {
    "intent": {
      "type": "choice",
      "choice": "billing",
      "probabilities": { "billing": 0.94, "technical": 0.06 },
      "confidence": 0.71,           // normalized entropy
      "answer_confidence": 0.94,    // calibrated — what this SDK exposes
      "action": { "act_probability": 0.9 }
    }
  },
  "usage": { "input_tokens": 42, "output_tokens": 0 },
  "routing": { "model": "english", "reason": "..." }
}
```

### Question and answer shapes

| Type | Request `criteria` | Answer fields |
|---|---|---|
| `choice` | `{label: description}` or `[label, …]` | `choice`, `probabilities`, `confidence`, `answer_confidence` |
| `score` | `[level0, level1, …]` (2–10, lowest first) | `score` (expected value), `legend`, `probabilities` |
| `noul` | optional `{true?, false?}` only | `noul` = P(yes), `confidence` |

A `noul` `criteria` keyed anything other than `true`/`false` is rejected by the
server with HTTP 422, so this package rejects it locally first.

### `GET /health`

```jsonc
{ "status": "ok", "loaded": ["english", "multilingual"], "device": "cuda" }
```

### The two confidence fields

Laya returns both on every answer, and they are not interchangeable:

- `answer_confidence` = `max(p)`, the probability mass on the reported answer.
  Calibrated — this is what temperature scaling is fitted on and what the
  published ECE measures. `laya-studio` surfaces it as `result.confidence`.
- `confidence` = normalized Shannon entropy `1 − H(p)/log(k)`, describing how
  concentrated the distribution is. Not calibrated, different scale. Preserved
  verbatim at `result.raw.confidence`.

Laya's source states plainly that the two must not be compared against the same
threshold. For `noul` they coincide; for `choice` and `score` they do not.

### The `model` field is not the checkpoint

The response's `model` is the constant string `laya-rl-agent` — a model family
id. The checkpoint that actually answered is `routing.model`
(`english` / `multilingual` / `typed-decisions`). `laya-studio` forwards
`model` verbatim and exposes the checkpoint separately as `meta.checkpoint`.

### Auth

`Authorization: Bearer <key>` — required only when the server was started with
`LAYA_API_KEY` set. Otherwise no header is sent.

### Server limits (mirrored client-side)

| Limit | Value |
|---|---|
| questions per request | 64 |
| state characters | 50,000 |
| request body | 2 MB |

These are checked before sending, so an oversized request fails immediately
with a clear message instead of costing a round trip.

### Status codes

| Code | Mapped to |
|---|---|
| 400, 413, 422 | `LayaValidationError` |
| 401 | `LayaAuthError` |
| 404 | `LayaConnectionError` (usually a base URL with a path on it) |
| 5xx | `LayaInferenceError` |

## What is *not* available

Stated plainly, because the absence shapes the design:

- **No batch endpoint.** `/v1/systemone` takes one state per request, so
  `batch()` is **client-side concurrency** — N requests, N forward passes.
  Laya's *Python* runtime has `predict_batch`, which packs states into shared
  forward passes, but it is **not exposed over HTTP** and a Node client cannot
  reach it. The batching that is real over HTTP is per-call: all questions in
  one request share a single forward pass, which is what `decide()` and
  `screen()` use.
- **No model-listing route.** `loadedModels()` reads `/health`'s `loaded`
  array — checkpoints resident in memory now, not a catalogue. The accepted
  names are a fixed set (`KNOWN_MODELS`): `english`, `multilingual`,
  `typed-decisions`.
- **No streaming.** Laya is non-autoregressive; there is nothing to stream.
- **No server-side timing breakdown.** Network time and inference time cannot
  be separated from a client, which is why `laya benchmark` reports them
  together and says so.

## Independence

```text
Node.js application → laya-studio → Laya HTTP endpoint
```

No Python dependency, runtime, or bridge. No coupling to any Python Laya
package. Zero npm runtime dependencies. A separate Python Laya Studio exists;
the two share no code and neither requires the other.
