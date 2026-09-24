# Contributing

```bash
npm install
npm test           # 173 tests, no GPU or Python needed
npm run typecheck  # includes compile-time inference tests
npm run lint
npm run build
```

## How the tests work

Everything runs against `tests/mock-server.ts`, an in-process fake that
reproduces the real Laya server's routes, status codes, limits, bearer check
and answer shapes. No GPU, no Python, no network.

| Suite | Covers |
|---|---|
| `client.test.ts` | classify, decide, score, screen, match, batch, cache, hooks, limits |
| `transport.test.ts` | every typed error, retries, auth, timeouts, custom transports |
| `router.test.ts` | dispatch, confidence gating, fallback, and the security properties |
| `config.test.ts` | env vars, precedence, `defineConfig`, `MemoryCache` |
| `eval.test.ts` | accuracy, precision/recall/F1, confusion matrix, percentiles |
| `types.test.ts` | **compile-time** inference assertions |
| `cli.test.ts` | the built binary as a real subprocess, incl. exit codes |
| `mcp.test.ts` | JSON-RPC handshake, schemas, tool dispatch, stdio binary |
| `integrations.test.ts` | Express and Fastify |

`types.test.ts` never executes — it asserts types. `npm run typecheck` fails if
label narrowing regresses.

## House rules

**Zero runtime dependencies.** The package depends on nothing at runtime, and
that is a feature people choose it for. A new dependency needs a real argument
that a few lines of stdlib cannot replace.

**Do not invent Laya API surface.** Every endpoint, field and question shape
must exist in Laya's server. If you are adding something, link the line in
[`laya/serve.py`](https://github.com/NandhaKishorM/laya/blob/main/laya/serve.py)
or [`laya/agent.py`](https://github.com/NandhaKishorM/laya/blob/main/laya/agent.py)
that supports it. When a capability does not exist — multi-state batching over
HTTP, model discovery — say so in the docs rather than papering over it.

Be specific about what "batching" means: Laya batches **questions** within one
request (one forward pass), and the HTTP API has no way to batch **states**.
`batch()` is client-side concurrency and must always be described as such.

**Never report a number that was not measured.** No estimated benchmarks, no
extrapolated throughput, no accuracy figures from anywhere but a real run.
Where a measurement is impossible from a client (splitting network from
inference time), state the limitation in the output.

**Model output is data.** Anything that would let a label select code to run,
a file to read, or a command to execute will be rejected. See
[docs/security.md](docs/security.md).

**Hooks get metadata only.** Never add user input or answers to a hook payload.
`tests/security.test.ts` asserts this; do not weaken it.

**Never collapse Laya's two confidence fields.** `answer_confidence` (= max p,
calibrated) and `confidence` (normalized entropy, uncalibrated) are different
quantities on different scales. `result.confidence` is the former; the latter
stays reachable at `result.raw.confidence`.

**Errors must be actionable.** An error message should tell someone what to do
next, not just what failed.

## Adding an operation

1. Confirm it maps to a real Laya question type (`choice`, `score`, `noul`).
2. Compile it in `src/decisions/spec.ts`; map the answer in `results.ts`.
3. Add the method to `src/client/laya.ts`, routed through `systemOne()` so it
   inherits caching, hooks and validation for free.
4. Tests: behaviour in `client.test.ts`, types in `types.test.ts`.
5. Surface it in the CLI and MCP server if it makes sense there.
6. Document it in the README.

Run `npm run lint && npm run typecheck && npm test` before opening a PR.
