# Changelog

All notable changes to `laya-studio` are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.2] — 2026-09-24

### Added

- **Presets** — five ready-made question sets ported verbatim from Laya's own
  `presets.py`: `triage`, `email`, `guard`, `moderation`, `router`. Same
  question names, instructions and criteria, so results match Laya's CLI.
  Available as `presets.*` in the SDK, `laya decide --preset <name>` in the
  CLI, and a `preset` parameter on the `laya_decide` MCP tool.
- **Schema-driven decisions** — `laya.decideFromSchema({ input, schema })`
  compiles a flat JSON Schema into Laya questions and decodes each answer back
  to the schema's own type. Mirrors `structured.py`, including its refusals:
  free strings, arrays, nested objects and `$ref` are rejected locally with
  Laya's own messages. Also exported as `questionsFromJsonSchema` and
  `planFromJsonSchema`.
- `CHANGELOG.md` and `SECURITY.md`.

### Fixed

- The MCP server reported a hardcoded version that had drifted from the
  package (`0.1.0` while shipping as `0.1.1`). It is now injected from
  `package.json` at build time and cannot go stale.

### Documented

- **What Laya cannot do over HTTP** — `docs/architecture.md` now states why
  there is no `extract` operation (Laya has no extraction primitive) and no
  `find`/`rerank` (its `shortlist.py` ranks via in-process embeddings that
  `/v1/systemone` does not expose). Both absences are deliberate.

### Unchanged

No existing API changed. `predict`, `classify`, `decide`, `score`, `screen`,
`match`, `batch`, `createRouter`, `health` and `loadedModels` behave exactly as
in 0.1.1.

## [0.1.1] — 2026-09-24

### Changed

- Relicensed from Apache-2.0 to **MIT**.

## [0.1.0] — 2026-09-24

Initial release, published under Apache-2.0 (see 0.1.1). Deprecated on npm.

- Typed SDK over Laya's `POST /v1/systemone` and `GET /health`
- `predict` as the canonical raw passthrough; `classify`, `decide`, `score`,
  `screen`, `match`, `batch` and `createRouter` as convenience layers
- Confidence kept faithful to Laya: `result.confidence` is `answer_confidence`
  (`max p`, calibrated); Laya's entropy-based `confidence` stays on `result.raw`
- Provider-agnostic fallback, in-memory cache, metadata-only hooks
- CLI with 13 commands; dependency-free MCP stdio server
- Express and Fastify integrations, typed structurally (no framework deps)
- Zero runtime dependencies; no Python dependency, runtime or bridge
