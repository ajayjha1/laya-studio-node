# Security

## Threat model in one line

Laya reads attacker-influenced text and returns a label. Everything here
follows from treating that label as **data**, never as an instruction.

## Guarantees

### Model output is never executed

The router resolves handlers through a `Map` built from the route keys you
registered:

```ts
this.handlers = new Map(names.map((name) => [name, options.routes[name]]));
```

A label outside that set matches nothing. This holds for `__proto__`,
`constructor`, `prototype` and every other prototype-chain name, because a
`Map` lookup does not walk the prototype chain. Both cases are covered by
tests in `tests/router.test.ts`.

If the server ever answers with a label that is not in the schema, the router
returns `handled: false, route: null` rather than guessing.

### Nothing is dynamically evaluated

No `eval`, no `new Function`, no dynamic `import()` of a model-supplied name,
no template-driven code generation.

### The MCP server exposes no shell

Tools are dispatched by a `switch` over a fixed allowlist of six names. There
is no command execution, no arbitrary file read, and no path parameter.
Anything outside the allowlist returns JSON-RPC `method not found`.

`laya_route` deliberately **reports** a routing decision and executes nothing —
running the handler stays the client's decision.

### Secrets stay in the environment

Nothing is hard-coded. `laya config` prints `(set)` for a present API key and
never the value, so it is safe in CI logs and screenshots.

### Hooks never see user input

`onRequest`, `onResponse` and `onError` receive metadata only — request id,
operation, latency, model, token counts. Logging user text is something an
application should choose deliberately, not inherit from enabling metrics.
Enforced and tested.

## Limitations — read these

### Laya's output is not an authorization boundary

`screen()` is a **signal**. A model can be wrong, its confidence can be wrong,
and an attacker chooses the input. Do not use it as the only thing standing
between a user and a privileged action.

```ts
// WRONG — a model decides who is an admin
if ((await laya.screen({ input, checks: { admin: 'Is this an admin?' } })).passed) {
  deleteAllRecords();
}

// RIGHT — authorization in code that consults no model
if (session.role === 'admin') {
  deleteAllRecords();
}
```

Use Laya to triage, route, prioritise and pre-filter. Keep authorization,
authentication and destructive-action gating in deterministic code.

### Confidence is calibrated, not correct

A calibrated 0.9 means roughly nine in ten such answers are right — not that
this one is. Laya's own model card notes the English checkpoint scores
**0.000 accuracy at 0.952 confidence** on scripts it cannot read, so a
confidence gate cannot rescue a checkpoint that is wrong about the input.
Match the checkpoint to the language, and measure with `laya eval` on your own
data before trusting a threshold.

### Base checkpoints are weak zero-shot

Laya's authors report ~0.362 accuracy zero-shot on typed decisions against
0.766 fine-tuned. Evaluate before shipping.

### Screening is not a prompt-injection solution

It raises the cost of an attack; it does not eliminate it. Combine with
least-privilege tool design, human confirmation on destructive actions, and
output validation.

### The endpoint is trusted

This package sends your input to the endpoint you configure and trusts the
response shape. Point it at a server you control, over a network you trust, and
use `LAYA_API_KEY` when the server is reachable beyond localhost.

`laya-serve` binds `0.0.0.0` with **no authentication** unless `LAYA_API_KEY`
is set. Do not expose it to a network without one.

## Reporting a vulnerability

Open a private security advisory rather than a public issue.
