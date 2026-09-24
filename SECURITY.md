# Security Policy

## Reporting a vulnerability

Please open a **private security advisory** on GitHub rather than a public
issue: <https://github.com/ajayjha1/laya-studio-node/security/advisories/new>

Include what you did, what you expected, and what happened. A proof of concept
helps. You will get an acknowledgement within a few days.

## Supported versions

The latest `0.1.x` release receives fixes. Older versions do not.

## What this package guarantees

These are asserted by tests in `tests/security.test.ts`, which run against the
**built bundles** rather than the source:

- **No dynamic code execution.** No `eval`, no `new Function`, no
  `child_process`, no process spawning.
- **Model output never selects code.** The router dispatches through a `Map`
  built from the route keys you registered, so a label outside that set —
  including `__proto__` or `constructor` — matches nothing.
- **The MCP server exposes no shell.** A fixed allowlist of seven `laya_*`
  tools, strict schemas, no command, path or code parameter.
- **Secrets stay out of output.** The API key never appears in an error or a
  log; `laya config` prints `(set)`, never the value.
- **User input never reaches a hook** — hooks receive metadata only.
- **Cache keys are SHA-256 hashes**, never plaintext input.
- **Zero runtime dependencies**, so there is no transitive supply chain.

## What it does not guarantee

- **Laya's output is not an authorization boundary.** `screen()` and the guard
  preset are signals. A model can be wrong, and an attacker chooses the input.
  Keep authorization in code that consults no model.
- **Confidence is calibrated, not correct.** A calibrated 0.9 means roughly
  nine in ten such answers are right, not that this one is.
- **The endpoint is trusted.** This package sends your input to the endpoint
  you configure and trusts the response shape. `laya-serve` binds `0.0.0.0`
  with no authentication unless `LAYA_API_KEY` is set — do not expose it to a
  network without one.

See [docs/security.md](docs/security.md) for the full reasoning.
