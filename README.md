# laya-studio

**Laya Studio is a Node.js/TypeScript developer toolkit for using [Laya](https://huggingface.co/convaiinnovations/laya) as a fast decision layer in AI applications.**

Laya is a non-autoregressive *System 1* decision model: give it text and typed questions, and it returns typed answers with calibrated probabilities in a single forward pass. It never generates text, so there is nothing to parse and nothing to hallucinate. (Laya's model card reports ~33 ms per call on a T4 GPU — that is their measurement, not one taken by this package. Use `laya benchmark` to measure your own deployment.)

`laya-studio` puts that in front of your Node.js code.

```bash
npm install laya-studio
```

```ts
import { Laya } from 'laya-studio';

const laya = new Laya({ endpoint: 'http://localhost:8000' });

const result = await laya.classify({
  input: 'My payment failed',
  labels: ['billing', 'technical', 'sales'],
});

result.label;         // "billing"  — typed "billing" | "technical" | "sales"
result.confidence;    // 0.94
result.probabilities; // { billing: 0.94, technical: 0.04, sales: 0.02 }
```

- **Zero runtime dependencies.** Node's built-in `fetch`, nothing else.
- **No Python.** This package talks to a Laya HTTP server over its documented API. It does not import, wrap, or shell out to anything Python.
- **Strict TypeScript.** Labels in, literal types out — no `as const` required.
- **Confidence is first-class.** Every answer carries Laya's calibrated `answer_confidence` — and this package never collapses it with Laya's other, uncalibrated confidence field.

---

## Contents

[Installation](#installation) · [Quick start](#quick-start) · [How it layers](#how-it-layers) · [predict()](#predict--the-canonical-call) · [Classification](#classification) · [Structured decisions](#structured-decisions) · [Routing](#routing) · [Confidence](#confidence) · [Fallback](#fallback) · [Batching](#batching) · [CLI](#cli) · [MCP](#mcp-server) · [Evaluation](#evaluation) · [Benchmarking](#benchmarking) · [Agent patterns](#agent-patterns) · [Express](#express) · [Fastify](#fastify) · [Next.js](#nextjs) · [Caching](#caching) · [Hooks](#hooks) · [Configuration](#configuration) · [Errors](#errors) · [API reference](#api-reference) · [Architecture](#architecture) · [Security](#security) · [Contributing](#contributing)

---

## Installation

```bash
npm install laya-studio
```

Requires **Node.js 18.17+** (for built-in `fetch`).

You also need a running Laya server. The Laya project ships one:

```bash
pip install "laya[serve]"
laya-serve                          # binds 0.0.0.0:8000
LAYA_DEVICE=cuda LAYA_PRELOAD=1 laya-serve   # GPU, checkpoints preloaded
```

> The Python package is only how *you* run the model server. `laya-studio` never touches it — it speaks HTTP to whatever endpoint you point it at, whether that is a local `laya-serve`, a container, or a remote host.

Check the connection:

```bash
npx laya health
```

### Try it in a browser

There is a playground app next door that exercises every operation with live
probability bars, confidence gating and latency:

```bash
cd ../laya-studio-playground
npm install
npm run dev     # includes a stand-in server, so no GPU or Python needed
```

It ships a stand-in Laya server that speaks the same HTTP contract, so the SDK
runs its real code path with nothing installed. That stand-in is **not the
model** — point it at a real `laya-serve` with `LAYA_ENDPOINT` for real
decisions.

---

## Quick start

```ts
import { Laya } from 'laya-studio';

const laya = new Laya(); // defaults to http://localhost:8000

const result = await laya.classify({
  input: 'My payment failed',
  labels: ['billing', 'technical', 'sales'],
});

if (result.isConfident(0.8)) {
  route(result.label);
} else {
  escalateToHuman();
}
```

---

## How it layers

```text
Your Node.js app
        │
        ▼
┌───────────────────────────────────────────────┐
│ laya-studio                                   │
│                                               │
│   predict()      ← canonical: raw passthrough │
│     ├── classify()   one choice question      │
│     ├── decide()     N mixed questions        │
│     ├── score()      one score question       │
│     ├── screen()     N noul questions         │
│     └── match()      one choice question      │
│                                               │
│   router · fallback · cache · hooks · retries │
│   evaluation · CLI · MCP                      │
└───────────────────┬───────────────────────────┘
                    │ HTTP
                    ▼
          POST /v1/systemone
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ Laya server                                   │
│   Router → english │ multilingual │ typed     │
└───────────────────────────────────────────────┘
```

`predict()` is the whole API surface; everything else is sugar over it. The
convenience methods exist because they add **types and ergonomics** that raw
questions cannot — `classify()` narrows its label to a literal union,
`decide()` maps each spec to its own result shape, `screen()` collapses N
checks into a pass/fail.

Reach for `predict()` when a question shape is not covered, or when you want
the server's payload untouched. You keep caching, hooks, retries, typed errors
and limit checks either way, because every method funnels through one place.

---

## `predict()` — the canonical call

Raw Laya questions in, raw Laya answers out. Nothing is reshaped or renamed.

```ts
const { answers, usage, meta } = await laya.predict({
  state: 'We were billed twice for March. Refund today or we cancel.',
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which department should handle this?',
      criteria: { billing: 'invoices, refunds', technical: 'bugs, outages' },
    },
    urgency: {
      type: 'score',
      instructions: 'How urgent is this?',
      criteria: ['not urgent', 'soon', 'blocking'],
    },
    churn: { type: 'noul', instructions: 'Do they threaten to cancel?' },
  },
});

answers.department.choice;            // "billing"
answers.department.probabilities;     // { billing: 0.94, technical: 0.06 }
answers.department.answer_confidence; // 0.94  — calibrated
answers.department.action.act_probability;
answers.urgency.score;                // 1.84
answers.churn.noul;                   // 0.892
meta.latencyMs;
```

All three questions above are answered in **one forward pass**.

Questions are validated against the server's own rules before sending — unknown
types, missing `instructions`, a `noul` `criteria` keyed anything but
`true`/`false` — so a mistake names the offending question immediately instead
of returning as an HTTP 422.

```bash
laya predict "billed twice" --questions-file questions.json
laya predict "billed twice" --questions '{"dept":{"type":"choice","instructions":"which team?","criteria":["billing","technical"]}}'
```

MCP clients get the same thing as `laya_predict`.

**When to use which:**

| | |
|---|---|
| `classify()` | you want one label, typed |
| `decide()` | several questions, each typed to its spec |
| `screen()` | several yes/no guardrails, as pass/fail |
| `predict()` | anything else, or the payload verbatim |

---

## Classification

`classify()` assigns exactly one label and returns a probability for every label you supplied.

```ts
const result = await laya.classify({
  input: 'My payment failed',
  labels: ['billing', 'technical', 'sales'],
});
```

```ts
{
  label: 'billing',
  confidence: 0.94,
  probabilities: { billing: 0.94, technical: 0.04, sales: 0.02 },
  raw:  { /* the server's answer, verbatim */ },
  meta: { requestId, latencyMs, model, routing, usage, cached },
}
```

**Label descriptions improve accuracy.** Pass an object instead of an array:

```ts
await laya.classify({
  input: ticket,
  labels: {
    billing:   'invoices, payments, refunds, duplicate charges',
    technical: 'bugs, outages, errors, broken features',
    sales:     'pricing, plans, new contracts, upgrades',
  },
});
```

**Structured input.** Anything JSON-serializable works — the model reads the whole record:

```ts
await laya.classify({
  input: { from: 'user@acme.com', subject: 'Invoice #4411', body: 'Billed twice…' },
  labels: ['billing', 'technical'],
});
```

### Type inference

The label type flows through. No `as const` needed:

```ts
const result = await laya.classify({
  input,
  labels: ['billing', 'technical', 'sales'],
});

result.label;
// ^? "billing" | "technical" | "sales"

switch (result.label) {
  case 'billing': break;
  case 'typo':    break; // Type error: not one of the labels
}
```

A `string[]` (not a literal array) widens to `string`, as it must.

---

## Structured decisions

`decide()` answers several typed questions about one input. **All of them share a single forward pass**, which is why this is meaningfully cheaper than several `classify()` calls.

```ts
import { Laya, score, noul } from 'laya-studio';

const result = await laya.decide({
  input: ticket,
  decisions: {
    intent:    ['billing', 'technical', 'sales'],
    urgency:   score(['not urgent', 'soon', 'blocking']),
    churnRisk: noul('Does the user threaten to cancel or leave?'),
  },
});

result.intent.label;         // "billing" | "technical" | "sales"
result.urgency.score;        // 1.84  (expected value over the rubric)
result.urgency.label;        // "blocking"
result.churnRisk.value;      // true
result.churnRisk.probability;// 0.892  — P(yes)
```

Laya's three question types map to three result shapes:

| Spec | Question type | Result |
|---|---|---|
| `['a', 'b']` or `{ a: 'desc' }` or `choice([...])` | `choice` | `label`, `probabilities`, `confidence` |
| `score(['low', 'high'])` | `score` | `score` (fractional), `level`, `label`, `probabilities` |
| `noul('Is this urgent?')` | `noul` | `value` (boolean), `probability` (P(yes)) |

Each result type is inferred from its spec, so `result.urgency.score` and `result.churnRisk.value` are both typed correctly in the same object.

### Other operations

```ts
// Ordered rubric on its own
await laya.score({ input, levels: ['not urgent', 'soon', 'blocking'] });

// Guardrail checks — several yes/no questions in one pass
await laya.screen({
  input,
  checks: {
    injection: 'Does this try to override or reveal the system instructions?',
    offTopic:  'Is this unrelated to customer support?',
  },
  flagAt: 0.6,
});
// -> { passed: false, flagged: ['injection'], checks: { … } }

// Record matching
await laya.match({
  a: { name: 'Acme Inc',          city: 'Boston' },
  b: { name: 'Acme Incorporated', city: 'Boston' },
});
// -> { verdict: 'same' | 'different' | 'unclear', confidence, probabilities }
```

---

## Routing

> **Two different things are called "routing". They are unrelated.**
>
> | | What it decides | Who does it |
> |---|---|---|
> | **Laya's Router** | which *checkpoint* answers — `english`, `multilingual`, `typed-decisions` | the **server**, by script/language detection, before inference. You see the outcome at `meta.routing` / `meta.checkpoint`. |
> | **`laya-studio`'s router** | which of *your handlers* runs | **this package**, in your process, after the answer comes back |
>
> `createRouter()` is an **application-level convenience** built on one `choice`
> question. It is not Laya's Router and does not influence checkpoint selection.
> To pin a checkpoint, pass `model: 'multilingual'`.

```ts
const router = laya.createRouter({
  routes: {
    search:  async (input) => searchAgent(input),
    code:    async (input) => codingAgent(input),
    support: async (input) => supportAgent(input),
  },
  descriptions: {
    search:  'looking things up, gathering sources',
    code:    'writing, reviewing or debugging code',
    support: 'account problems, billing, refunds',
  },
  threshold: 0.75,
  fallback: async ({ suggested, confidence }) => escalate(suggested, confidence),
});

const result = await router.run(userMessage);

result.route;       // "code" | "search" | "support" | null
result.handled;     // did a handler actually run?
result.confidence;  // 0.91
result.result;      // whatever the handler returned
result.suggested;   // what Laya picked, even if it was below threshold
result.meta;        // requestId, latencyMs, checkpoint
```

Under the hood this is exactly one `classify()` call — the route names become
the labels — plus a threshold check and a lookup. Nothing about it is a Laya
primitive; you could write it yourself in a dozen lines, and `predict()` is
there if you want to.

When confidence is below threshold, the router runs your `fallback` if you gave
it one, and otherwise returns `handled: false` with `route: null`. It never
guesses.

**The model cannot name code to run.** Handlers are looked up in a `Map` built
from the keys you registered, so a label outside that set — including
`__proto__` or `constructor` — matches nothing and executes nothing. This is
tested.

There is deliberately **no `laya.route()` method**. Routing needs a handler
table, so it is constructed (`createRouter`) rather than called. The CLI's
`laya route` is a *reporting* command: it prints which route would be chosen
and executes nothing, because handlers live in application code, not on a
command line.

---

## Confidence

Every result carries a confidence and the full probability distribution.

```ts
result.confidence;          // Laya's answer_confidence = max(probabilities)
result.probabilities;       // Laya's probabilities map, verbatim
result.isConfident();       // against the client's threshold (default 0.8)
result.isConfident(0.95);   // against a threshold for this decision
result.raw;                 // the server's answer object, untouched
```

```ts
if (!result.isConfident(0.8)) {
  return escalateToHuman();
}
```

### Laya returns two different confidence numbers

This matters, and collapsing them would be a bug:

| Laya field | What it is | Calibrated? |
|---|---|---|
| `answer_confidence` | `max(p)` — the probability mass on the answer it reported | **Yes.** This is what Laya's temperature scaling is fitted on and what its published ECE measures. Of the answers returned at confidence *c*, about *c* of them are right. |
| `confidence` | Normalized Shannon entropy, `1 − H(p)/log(k)` — how concentrated the whole distribution is | **No.** Different quantity, different scale. |

`laya-studio` exposes **`answer_confidence` as `result.confidence`**, because it
is the one you can gate on. Laya's own `confidence` field is preserved verbatim
at `result.raw.confidence`.

> Laya's source is explicit that the two **must not be compared against the same
> threshold**. If you read `raw.confidence`, do not feed it to `isConfident()`.

For a `noul` question the two are arithmetically identical, because over two
options `max(p)` and `max(p_yes, 1 − p_yes)` are the same number. They diverge
only for `choice` and `score`.

For a `score` question, `confidence` is the probability of the single most
likely **level** — it does not describe how precise the expected-value `score`
is.

### What comes from Laya, and what laya-studio computes

| Field | Source |
|---|---|
| `label` (choice) | Laya's `choice`, verbatim |
| `probabilities` | Laya's `probabilities`, verbatim |
| `confidence` | Laya's `answer_confidence`, verbatim |
| `score` | Laya's `score` (an expected value), verbatim |
| `raw` | the server's whole answer object, untouched |
| `meta.model` | Laya's `model` field — a **family id** (`laya-rl-agent`), not a checkpoint |
| `meta.routing`, `meta.usage` | Laya's fields, verbatim |
| `meta.checkpoint` | **derived** — read from `routing.model` |
| `level` (score) | **computed** — argmax of `probabilities` |
| `label` (score) | **looked up** — `legend[level]` |
| `value` (noul) | **computed** — `probability > 0.5`; the cutoff is this SDK's choice, not Laya's |
| `passed` / `flagged` (screen) | **computed** — each probability vs `flagAt` |
| `verdict` (match) | **computed** — the chosen label; the three verdicts are this SDK's wording |
| `meta.latencyMs`, `meta.requestId`, `meta.cached` | **measured/generated** by laya-studio |
| `isConfident()` | **laya-studio** — a comparison, not a model output |

`action.act_probability` (Laya's act/escalate head) is forwarded verbatim on
`raw.action`. No operation in this package gates on it, and no meaning is
claimed for it beyond what Laya's model card states.

`isConfident` is non-enumerable, so `JSON.stringify(result)` gives clean data
with no function in it.

---

## Fallback

Put Laya in front of a slower, more expensive model. Laya answers first; the expensive one is called only when Laya is unsure.

```text
Input
  ↓
Laya
  ↓
confidence
 ├── high → use the decision
 └── low  → fallback
```

```ts
const result = await laya.classify({
  input,
  labels: ['billing', 'technical', 'sales'],
  fallback: async ({ input, confidence }) => {
    return expensiveModel(input); // returns one of the labels
  },
});

result.meta.fallbackUsed; // true when the fallback decided
```

The fallback is **provider-agnostic** — `laya-studio` imports no model SDK and has no notion of OpenAI, Anthropic, or anyone else. It hands you the input and takes back a label.

Two deliberate choices:

- The fallback returns **a label**, so the result keeps its shape and its types.
- `probabilities` still describe *Laya's* view after a fallback runs. Overwriting them would mean inventing numbers the fallback never produced.

The fallback must be `async`. That is a type-system trade: a `L | Promise<L>` return stops TypeScript from narrowing the returned literal, which would force `as const` on every call site.

---

## Batching

**`batch()` is client-side concurrency. It is not server-side or GPU batching.**

```ts
const results = await laya.batch([
  { input: 'billing problem', decisions: { intent: labels } },
  { input: 'the app crashes', decisions: { intent: labels } },
], { concurrency: 8 });

results[0].ok;                        // per item, so one failure does not lose the rest
results[0].results.intent.label;
```

Laya's HTTP interface, `POST /v1/systemone`, accepts **one state per request**.
There is no batch route. So `batch()` issues one HTTP request per item and
overlaps them, bounded by `concurrency` (default 8). Every item is a separate
forward pass on the server. Nothing here is batched by the model.

> Laya's **Python** runtime does have `Agent.predict_batch` / `Router.predict_batch`,
> which packs multiple states into shared forward passes. **That is not exposed
> over HTTP**, so a Node client cannot reach it. If you need true multi-state
> batching, you need a server-side path that does not exist in the HTTP API today.

### The one thing that *is* batched by the model

Every question in a **single** call is answered in one forward pass. That is a
property of Laya itself, and it is what makes `decide()` and `screen()` cheaper
than the equivalent separate calls:

```ts
// One HTTP request, one forward pass, five answers.
await laya.decide({ input, decisions: { intent, urgency, churn, refund, sentiment } });

// Five HTTP requests, five forward passes. Same answers, more work.
await Promise.all([...]);
```

So: **questions batch, states do not.**

Pass `{ throwOnError: true }` to reject on the first failure instead of
collecting per-item outcomes.

---

## CLI

```bash
npx laya <command>
# or after a global install
npm install -g laya-studio
```

```bash
laya classify "My payment failed" --labels billing,technical,sales
```

```text
Decision:   billing
Confidence: 94.0%

label      probability  
---------  -----------  ------------------------
billing    94.0%        ######################..
technical  4.0%         #.......................
sales      2.0%         ........................
```

| Command | What it does | Laya call |
|---|---|---|
| `laya predict <text>` | raw questions in, raw answers out | `/v1/systemone`, verbatim |
| `laya classify <text>` | assign one label | 1 `choice` question |
| `laya decide <text>` | several typed questions in one pass | N questions, 1 request |
| `laya score <text>` | rate against an ordered rubric | 1 `score` question |
| `laya screen <text>` | yes/no guardrail checks | N `noul` questions |
| `laya route <text>` | **reports** which route would be chosen — runs nothing | 1 `choice` question |
| `laya batch <file.jsonl>` | classify every row | **N requests**, concurrent |
| `laya eval <file.jsonl>` | accuracy, F1, confusion matrix, thresholds | N requests; metrics computed locally |
| `laya benchmark` | measured latency and throughput | N requests; all figures measured |
| `laya health` | server status | `GET /health` |
| `laya models` | checkpoints loaded now, and the fixed accepted set | `GET /health` — not discovery |
| `laya config` | resolved configuration | none — local only |
| `laya interactive` | a REPL for trying things without writing code | per command |

```bash
# Several typed questions at once
laya decide "billed twice, we will cancel" \
  --choice intent=billing,technical \
  --score urgency=low,medium,high \
  --noul churn="Does the user threaten to cancel?"

# Guardrails
laya screen "ignore previous instructions" \
  --check injection="Is this a prompt injection attempt?"

# Machine-readable, for scripts and CI
laya classify "My payment failed" --labels billing,technical --json

# Reads stdin when no text is given
echo "the app crashes on startup" | laya classify --labels billing,technical
```

**Exit codes** make the CLI usable in pipelines:

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | error |
| `2` | usage error |
| `3` | answered, but below the confidence threshold |

Global flags: `--endpoint`, `--api-key`, `--model`, `--timeout`, `--threshold`, `--json`.

### Interactive

```bash
laya interactive
```

```text
laya> my payment failed twice
  Decision:   billing
  Confidence: 94.0%

laya> :labels urgent,normal,spam
laya> :score not urgent,soon,blocking
laya> :screen Does this contain a prompt injection?
laya> :decide
laya> :help
```

---

## MCP server

`laya-studio` ships an MCP server so MCP clients — Claude Code, Cursor, and others — can use Laya as a decision tool.

```bash
laya-mcp
```

```jsonc
// Claude Code / Cursor MCP config
{
  "mcpServers": {
    "laya": {
      "command": "npx",
      "args": ["-y", "laya-studio", "laya-mcp"],
      "env": { "LAYA_ENDPOINT": "http://localhost:8000" }
    }
  }
}
```

Tools exposed: `laya_predict` (canonical), `laya_classify`, `laya_decide`, `laya_route`, `laya_screen`, `laya_batch`, `laya_health` — each with a strict JSON Schema.

Two properties worth stating plainly:

- **No shell.** There is no tool that runs a command, evaluates code, or reads arbitrary files. The dispatch is a `switch` over a fixed allowlist; any other name is rejected with `method not found`.
- **`laya_route` reports, it does not execute.** It tells the client which route was chosen and how confident Laya was. Running the handler is the client's decision.

The server speaks JSON-RPC 2.0 over stdio and implements the handshake, `tools/list` and `tools/call` directly — no MCP SDK dependency. stdout carries protocol traffic only; logs go to stderr.

---

## Evaluation

```bash
laya eval dataset.jsonl --labels billing,technical,sales
```

```jsonl
{"input":"My payment failed","expected":"billing"}
{"input":"The app crashes","expected":"technical"}
```

Reports accuracy, per-label precision/recall/F1, macro and weighted averages, a confusion matrix, confidence broken down by correct vs. wrong, latency percentiles, throughput, and a **confidence threshold analysis**:

```text
Threshold analysis  (accuracy among rows kept at each threshold)
threshold  coverage  accuracy  deferred
---------  --------  --------  --------
0.50       100.0%    82.0%     0
0.80       71.0%     95.8%     29
0.90       54.0%     98.1%     46
```

That table is the one to read before shipping: it tells you what threshold buys you, and how much traffic a fallback would have to absorb.

Options: `--concurrency`, `--thresholds`, `--min-accuracy` (exit 1 below it — useful as a CI gate), `--json`.

The same metrics are available programmatically:

```ts
import { evaluate, summarize } from 'laya-studio';
```

---

## Benchmarking

```bash
laya benchmark --runs 50 --concurrency 8
```

Measures, in your environment, against your endpoint:

- p50 / p95 / p99 warm latency
- cold start (first request) vs. warm
- sequential and concurrent throughput
- **SDK overhead**, measured separately with an in-process transport

```text
Where the time goes
stage                p50 ms
-------------------  ------
SDK overhead         0.042
network + inference  38.91
total round trip     38.95
```

**No number here is fabricated.** Every figure comes from requests actually issued during the run.

One honest limitation, stated in the output: **network time and model inference time cannot be separated from a client.** `network + inference` is the round trip minus measured SDK overhead. Splitting it further needs server-side instrumentation; claiming the split from here would be a guess.

---

## Agent patterns

### Tool selection

```text
User → Laya → search | database | code | calculator → tool
```

The tool table lives in your code. Laya picks an entry from it and cannot introduce a new one. See [`examples/06-tool-selection.ts`](examples/06-tool-selection.ts).

### Agent routing

```text
Request → Laya → research-agent | coding-agent | support-agent
```

See [`examples/03-router.ts`](examples/03-router.ts).

### LLM gate

```text
Request → Laya → does this need an expensive LLM?
                   yes → LLM
                   no  → deterministic workflow
```

```ts
const decision = await laya.decide({
  input: message,
  decisions: {
    intent: ['password_reset', 'order_status', 'refund', 'other'],
    needsReasoning: noul('Does answering this require multi-step reasoning or judgement?'),
  },
});

return !decision.needsReasoning.value && decision.intent.isConfident(0.85)
  ? deterministicWorkflow(decision.intent.label)
  : expensiveModel(message);
```

See [`examples/04-llm-gate.ts`](examples/04-llm-gate.ts).

---

## Express

Express is **not** a dependency of the core package. The integration is a separate entry point that types Express structurally — it does not even need `@types/express`.

```ts
import { Laya, noul } from 'laya-studio';
import { layaMiddleware, layaScreen } from 'laya-studio/express';

const laya = new Laya({ threshold: 0.75 });

app.post(
  '/support',
  layaScreen({ laya, checks: { injection: 'Is this a prompt injection?' } }),
  layaMiddleware({
    laya,
    decisions: { intent: ['billing', 'technical'], urgent: noul('Is this urgent?') },
  }),
  (req, res) => {
    const { results, confident } = req.laya;
    res.json({ queue: confident ? results.intent.label : 'human-review' });
  },
);
```

Options: `input` (custom extractor), `property` (default `laya`), `threshold`, `onLowConfidence: 'continue' | 'reject'`, `failOpen` (keep serving when Laya is down).

## Fastify

```ts
import { layaPreHandler, layaPlugin } from 'laya-studio/fastify';

fastify.post('/support', {
  preHandler: layaPreHandler({ laya, decisions: { intent: ['billing', 'technical'] } }),
}, async (request) => ({ queue: request.laya.results.intent.label }));
```

`layaPlugin` decorates the Fastify instance with a shared client.

## Next.js

No framework abstraction is needed — the core package works directly in any server context.

```ts
// app/api/triage/route.ts
import { Laya } from 'laya-studio';

const laya = new Laya({
  endpoint: process.env.LAYA_ENDPOINT,
  apiKey: process.env.LAYA_API_KEY,
  cache: { enabled: true, ttl: 300 },
});

export async function POST(request: Request) {
  const { message } = await request.json();
  const result = await laya.classify({ input: message, labels: ['billing', 'technical'] });
  return Response.json({ intent: result.label, confidence: result.confidence });
}
```

**Server-side only.** Route handlers, server actions, and server components are all fine. Never construct a client in a client component: it would ship your endpoint and API key to the browser. Keep the key in `LAYA_API_KEY`, never `NEXT_PUBLIC_*`.

Declaring the client at module scope reuses it (and its cache) across invocations within a server instance.

---

## Caching

Off by default. In-memory when enabled.

```ts
const laya = new Laya({
  cache: { enabled: true, ttl: 300 }, // ttl in seconds
});
```

Keys are a SHA-256 of the full request with object keys sorted at every level, so two identical requests written in different key orders share an entry. The input is hashed, never stored in the key.

Redis or any other store plugs in through the interface — nothing about Redis is required, or bundled:

```ts
import type { LayaCache } from 'laya-studio';

class RedisCache implements LayaCache {
  async get(key: string) { /* … */ }
  async set(key: string, value: unknown, ttlSeconds: number) { /* … */ }
}

new Laya({ cache: { enabled: true, ttl: 300, store: new RedisCache() } });
```

The built-in `MemoryCache` is single-process, TTL-bounded, and evicts least-recently-used entries at `maxEntries` (default 1000).

---

## Hooks

```ts
const laya = new Laya({
  hooks: {
    onRequest:  ({ requestId, operation, questionCount }) => metrics.increment(operation),
    onResponse: ({ requestId, latencyMs, checkpoint, cached, usage }) => metrics.timing(latencyMs),
    onError:    ({ requestId, error, latencyMs }) => logger.error({ requestId, error }),
  },
});
```

**Hooks receive metadata only — never the input text, and never the answers.** Logging user input is a decision an application should make deliberately, not something that happens as a side effect of enabling observability. This is enforced and tested.

A hook that throws is caught and reported on stderr; it never fails a request that already succeeded.

---

## Configuration

Precedence: **explicit options → environment → `laya.config.ts` (CLI only) → defaults**.

```ts
// laya.config.ts
import { defineConfig } from 'laya-studio';

export default defineConfig({
  endpoint: 'http://localhost:8000',
  threshold: 0.8,
  timeout: 10_000,
});
```

| Variable | Default |
|---|---|
| `LAYA_ENDPOINT` | `http://localhost:8000` |
| `LAYA_API_KEY` | — (only needed if the server sets it) |
| `LAYA_MODEL` | auto-routed by the server |
| `LAYA_TIMEOUT` | `10000` |
| `LAYA_THRESHOLD` | `0.8` |

All options:

```ts
new Laya({
  endpoint, apiKey, model, timeout, threshold,
  retries,      // default 2 — connection failures and 5xx only, never validation
  concurrency,  // default 8 — in-flight requests for batch()
  cache, hooks, headers, transport, fetch,
});
```

An invalid `LAYA_TIMEOUT` throws rather than silently falling back to a default.

**Never hard-code secrets.** `laya config` prints `(set)` for a present API key, never the value.

---

## Errors

Every failure is one of five typed errors, each with an actionable message.

```ts
import { isLayaError, LayaConnectionError, LayaTimeoutError } from 'laya-studio';

try {
  await laya.classify({ input, labels });
} catch (error) {
  if (error instanceof LayaConnectionError) { /* server down */ }
  if (isLayaError(error)) console.error(error.code, error.endpoint);
}
```

| Error | `code` | When |
|---|---|---|
| `LayaConnectionError` | `CONNECTION` | unreachable, wrong base URL, non-JSON response |
| `LayaTimeoutError` | `TIMEOUT` | request exceeded its deadline |
| `LayaValidationError` | `VALIDATION` | bad request — HTTP 400 / 413 / 422, or caught locally |
| `LayaInferenceError` | `INFERENCE` | server-side failure (5xx) |
| `LayaModelError` | `MODEL` | a response arrived without the answer that was asked for |
| `LayaAuthError` | `AUTH` | HTTP 401 — bearer token missing or wrong |

Messages tell you what to do:

```text
Unable to connect to Laya at http://localhost:8000.

Check that the Laya server is running:
  pip install "laya[serve]" && laya-serve

If it runs elsewhere, set LAYA_ENDPOINT or pass { endpoint } to new Laya().
```

Retries apply to connection failures and 5xx only. A validation error is never retried — retrying a malformed request cannot help.

Request limits are mirrored from the server and checked locally, so an oversized request fails immediately with a clear message instead of costing a round trip: **64 questions**, **50,000 state characters**, **2 MB body**.

---

## API reference

### `new Laya(options?)`

| Method | Maps to | Returns |
|---|---|---|
| `predict({ state, questions })` | **the API itself** — `POST /v1/systemone`, verbatim in and out | `SystemOneResponse & { meta }` |
| `classify({ input, labels, … })` | one `choice` question | `ChoiceResult<L>` |
| `decide({ input, decisions })` | N mixed questions, **one forward pass** | `{ [K in keyof D]: ResultFor<D[K]> }` |
| `score({ input, levels, … })` | one `score` question | `ScoreResult` |
| `screen({ input, checks, flagAt? })` | N `noul` questions; `passed`/`flagged` computed locally | `ScreenResult` |
| `match({ a, b, … })` | one `choice` question over 3 verdicts *(wording is this SDK's)* | `ChoiceResult & { verdict }` |
| `batch(items, options?)` | **N separate requests**, client-side concurrency | `BatchOutcome[]` |
| `createRouter({ routes, … })` | one `choice` question + local dispatch | `LayaRouter` |
| `health()` | `GET /health`, verbatim | `{ status, loaded, device }` |
| `loadedModels()` | `GET /health` → its `loaded` array | `string[]` |

Only `predict`, `health` and `loadedModels` are thin wrappers over an endpoint.
Everything else is a **convenience layer** that compiles to the same
`/v1/systemone` call — they add types and ergonomics, not capability.

Every method accepts `model`, `threshold`, `timeout` and `signal`.

### Builders

`choice(labels, instructions?)` · `score(levels, instructions?)` · `noul(instructions, { whenTrue?, whenFalse? })` · `defineConfig(config)`

### Types

`ChoiceResult<L>` · `ScoreResult` · `NoulResult` · `DecideResults<D>` · `ResultFor<S>` · `LayaConfig` · `LayaTransport` · `LayaCache` · `LayaHooks` · `LayaState` · `LayaQuestion` · `LayaAnswer`

**There is no model-discovery endpoint.** `loadedModels()` reads the `loaded`
array from `/health`, which reports the checkpoints resident in memory *right
now* — a lazily-loading server returns an empty list until it has served a
request, and a checkpoint missing from it may still be usable. The names a
request's `model` field accepts are a fixed set, exported as `KNOWN_MODELS`:
`english`, `multilingual`, `typed-decisions`.

---

## Architecture

```text
Your Node.js application
          │
          ▼
     laya-studio
     ├── client      predict (canonical) → classify / decide / score / screen / match / batch
     ├── decisions   spec → question, answer → typed result
     ├── router      confidence-gated dispatch to registered handlers
     ├── cache       interface + in-memory store
     ├── hooks       metadata-only observability
     ├── errors      five typed, actionable errors
     └── transport   LayaTransport  ← the only seam that touches the network
          │
          ▼
    HTTP  POST /v1/systemone
          GET  /health
          │
          ▼
  Laya inference server (laya-serve, or any compatible endpoint)
```

Everything above the transport is network-agnostic. Swapping in a different transport — a test double, a custom network stack, a future hosted Laya — changes nothing else:

```ts
new Laya({
  transport: {
    endpoint: 'custom://laya',
    async request<T>({ path, method, body }): Promise<T> { /* … */ },
  },
});
```

### What this package talks to

`laya-studio` targets the documented Laya HTTP interface and nothing else:

| | |
|---|---|
| `POST /v1/systemone` | `{ state, questions, model? }` → `{ model, answers, usage, routing }` |
| `GET /health` | `{ status, loaded, device }` |
| Auth | `Authorization: Bearer <key>`, only when the server sets `LAYA_API_KEY` |

The question and answer shapes — `choice` / `score` / `noul`, `probabilities`, `confidence`, `answer_confidence`, `action.act_probability`, `usage` — mirror the server exactly. No endpoint or field in this package was invented.

Laya's server is Jev-compatible on this route, so a compatible endpoint works by changing `endpoint`.

### Independence

This package is **completely standalone**:

- no Python dependency, runtime, or bridge
- no import of, or coupling to, any Python Laya package
- zero npm runtime dependencies
- a separate Python Laya Studio exists; the two share no code and neither requires the other

---

## Security

Deliberate limits, and the reasoning behind each:

- **Model output is never executed.** The router dispatches through a `Map` built from the route keys you registered. A label outside that set matches nothing — including `__proto__` and `constructor`. Tested directly.
- **Nothing is dynamically evaluated.** No `eval`, no `new Function`, no dynamic import of model-named modules.
- **Laya's output is not an authorization boundary.** `screen()` is a signal. A model can be wrong, and an attacker chooses the input. Keep authorization in code that does not consult a model.
- **The MCP server exposes no shell.** Fixed tool allowlist, strict schemas, no command execution and no arbitrary file access.
- **Secrets stay in the environment.** Nothing is hard-coded; `laya config` prints `(set)`, never the key.
- **Hooks never receive user input** — metadata only, by design.
- **Request limits are enforced client-side** before a round trip.

Reporting a vulnerability: please open a security advisory rather than a public issue.

---

## Contributing

```bash
git clone <repo> && cd laya-studio
npm install
npm test          # 170+ tests against a mock Laya server
npm run typecheck # includes compile-time inference tests
npm run lint
npm run build
```

The test suite runs entirely against an in-process mock that reproduces the real server's routes, status codes, limits and answer shapes — no GPU or Python needed.

Type-level behaviour is tested too: `tests/types.test.ts` asserts the inference contract at compile time, so `npm run typecheck` fails if label narrowing ever regresses.

Guidelines: keep the runtime dependency count at zero, do not invent Laya API surface, and never report a measured number that was not measured.

---

## License

MIT — see [LICENSE](LICENSE).

Laya itself is Apache-2.0. `laya-studio` is an independent Node.js client that talks to Laya over HTTP; it contains no Laya code, so the two licenses apply separately.

Laya is built by [Convai Innovations](https://huggingface.co/convaiinnovations). This package is an independent Node.js client and is not affiliated with them.
