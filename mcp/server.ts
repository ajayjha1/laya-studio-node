#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Laya } from '../src/index.js';
import {
  LATEST_PROTOCOL_VERSION,
  RpcCode,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './protocol.js';
import { TOOL_DEFINITIONS, callTool } from './tools.js';

// Injected at build time from package.json so it cannot drift from the release.
declare const __LAYA_VERSION__: string;
const SERVER_INFO = {
  name: 'laya-studio',
  version: typeof __LAYA_VERSION__ === 'string' ? __LAYA_VERSION__ : '0.0.0-dev',
} as const;

/**
 * MCP server exposing Laya's decision operations.
 *
 * Reads newline-delimited JSON-RPC on stdin and writes responses on stdout.
 * stdout carries protocol traffic only — every log goes to stderr, because a
 * stray `console.log` would corrupt the stream.
 */
export function createServer(laya: Laya): {
  handle: (request: JsonRpcRequest) => Promise<JsonRpcResponse | undefined>;
} {
  let initialized = false;

  const ok = (id: string | number | null, result: unknown): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id,
    result,
  });
  const fail = (id: string | number | null, code: number, message: string): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });

  return {
    async handle(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
      const id = request.id ?? null;
      const params = request.params ?? {};

      switch (request.method) {
        case 'initialize': {
          const requested = params.protocolVersion;
          // Echo the client's version when we speak it; otherwise name ours and
          // let the client decide whether it can proceed.
          const protocolVersion =
            typeof requested === 'string' &&
            (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
              ? requested
              : LATEST_PROTOCOL_VERSION;

          initialized = true;
          return ok(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions:
              'Laya is a fast decision layer: it answers typed questions with calibrated ' +
              'probabilities in one forward pass and never generates text. laya_predict is the ' +
              'canonical call (raw questions in, raw answers out); laya_classify, laya_decide, ' +
              'laya_route, laya_screen and laya_batch are convenience wrappers over it. ' +
              'Confidence is Laya\'s answer_confidence (= the probability of the reported ' +
              'answer) — check it before acting. Note laya_batch is client-side concurrency, ' +
              'not model batching; to batch work, put several questions in one laya_decide. ' +
              'Laya output is a signal, never an authorization decision.',
          });
        }

        // Notifications carry no id and must not be answered.
        case 'notifications/initialized':
        case 'initialized':
          initialized = true;
          return undefined;

        case 'notifications/cancelled':
          return undefined;

        case 'ping':
          return ok(id, {});

        case 'tools/list':
          return ok(id, { tools: TOOL_DEFINITIONS });

        case 'tools/call': {
          const name = params.name;
          if (typeof name !== 'string') {
            return fail(id, RpcCode.invalidParams, 'tools/call requires a string "name".');
          }
          const args = params.arguments;
          if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
            return fail(id, RpcCode.invalidParams, '"arguments" must be an object.');
          }
          if (!TOOL_DEFINITIONS.some((tool) => tool.name === name)) {
            return fail(id, RpcCode.methodNotFound, `Unknown tool: ${name}`);
          }
          const result = await callTool(laya, name, (args ?? {}) as Record<string, unknown>);
          return ok(id, result);
        }

        // Declared as unsupported rather than left to time out.
        case 'resources/list':
          return ok(id, { resources: [] });
        case 'prompts/list':
          return ok(id, { prompts: [] });

        default:
          if (request.id === undefined) return undefined; // unknown notification
          return fail(
            id,
            RpcCode.methodNotFound,
            initialized
              ? `Method not found: ${request.method}`
              : `Server not initialized; send "initialize" first (got ${request.method}).`,
          );
      }
    },
  };
}

function main(): void {
  const laya = new Laya();

  // stderr only: stdout is the protocol channel.
  console.error(`[laya-studio mcp] endpoint ${laya.endpoint}`);

  const server = createServer(laya);
  const rl = createInterface({ input: process.stdin });

  const write = (response: JsonRpcResponse): void => {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  };

  // A tool call is asynchronous, so stdin can close while one is still in
  // flight. Exiting on 'close' would discard that reply — which is exactly what
  // happens to any client that writes its requests and closes the pipe. Track
  // outstanding work and leave only once it has drained.
  let pending = 0;
  let inputClosed = false;
  const settle = (): void => {
    pending--;
    if (inputClosed && pending === 0) process.exit(0);
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed === '') return;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: RpcCode.parseError, message: 'Parse error' } });
      return;
    }

    if (typeof request !== 'object' || request === null || typeof request.method !== 'string') {
      write({
        jsonrpc: '2.0',
        id: null,
        error: { code: RpcCode.invalidRequest, message: 'Invalid Request' },
      });
      return;
    }

    pending++;
    void server
      .handle(request)
      .then((response) => {
        if (response) write(response);
      })
      .catch((error: unknown) => {
        write({
          jsonrpc: '2.0',
          id: request.id ?? null,
          error: {
            code: RpcCode.internalError,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      })
      .finally(settle);
  });

  rl.on('close', () => {
    inputClosed = true;
    if (pending === 0) process.exit(0);
  });
}

/**
 * Start only when this file is the entrypoint, so tests can import
 * `createServer` without spawning a server.
 *
 * The comparison is on real paths: npm installs the binary as a symlink
 * (`node_modules/.bin/laya-mcp`), so `process.argv[1]` and `import.meta.url`
 * name the same file by different paths. Matching on the path *text* would
 * miss `node dist/mcp.js`, leaving the process silently doing nothing.
 */
function isEntrypoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main();
}
