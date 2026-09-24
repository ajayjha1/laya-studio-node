import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Laya } from '../src/index.js';
import { createServer } from '../mcp/server.js';
import { TOOL_DEFINITIONS, callTool } from '../mcp/tools.js';
import { LATEST_PROTOCOL_VERSION, RpcCode } from '../mcp/protocol.js';
import { startMockServer, type MockServer } from './mock-server.js';

let server: MockServer;
let laya: Laya;
let mcp: ReturnType<typeof createServer>;

beforeAll(async () => {
  server = await startMockServer();
  laya = new Laya({ endpoint: server.url, retries: 0, threshold: 0.3 });
  mcp = createServer(laya);
});
afterAll(async () => {
  await server.close();
});

const call = (method: string, params?: Record<string, unknown>, id: number | null = 1) =>
  mcp.handle({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

describe('stdio binary', () => {
  it('answers an async tool call even when stdin closes immediately', async () => {
    // Regression: the server used to exit on stdin 'close', discarding replies
    // for tool calls still awaiting the network. Any client that writes its
    // requests and closes the pipe hit this.
    const { spawn } = await import('node:child_process');

    const lines = await new Promise<string[]>((resolve, reject) => {
      const child = spawn('node', ['dist/mcp.js'], {
        cwd: process.cwd(),
        env: { ...process.env, LAYA_ENDPOINT: server.url },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += String(chunk);
      });
      child.on('error', reject);
      child.on('close', () => resolve(out.trim().split('\n').filter(Boolean)));

      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'laya_classify',
            arguments: { input: 'my billing payment failed', labels: ['billing', 'technical'] },
          },
        })}\n`,
      );
      child.stdin.end();
    });

    const responses = lines.map((line) => JSON.parse(line) as { id: number; result?: unknown });
    const toolCall = responses.find((r) => r.id === 2);

    expect(toolCall).toBeDefined();
    const content = (toolCall!.result as { content: Array<{ text: string }> }).content;
    expect((JSON.parse(content[0]!.text) as { label: string }).label).toBe('billing');
  }, 30_000);
});

describe('handshake', () => {
  it('answers initialize with capabilities and server info', async () => {
    const response = await call('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION });
    const result = response!.result as Record<string, unknown>;

    expect(response!.error).toBeUndefined();
    expect(result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(result.capabilities).toHaveProperty('tools');
    expect(result.serverInfo).toMatchObject({ name: 'laya-studio' });
  });

  it('echoes an older protocol version it supports', async () => {
    const response = await call('initialize', { protocolVersion: '2024-11-05' });
    expect((response!.result as { protocolVersion: string }).protocolVersion).toBe('2024-11-05');
  });

  it('falls back to its own version for an unknown one', async () => {
    const response = await call('initialize', { protocolVersion: '1999-01-01' });
    expect((response!.result as { protocolVersion: string }).protocolVersion).toBe(
      LATEST_PROTOCOL_VERSION,
    );
  });

  it('does not reply to notifications', async () => {
    expect(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
    expect(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/cancelled' })).toBeUndefined();
  });

  it('answers ping', async () => {
    expect((await call('ping'))!.error).toBeUndefined();
  });

  it('returns method-not-found for an unknown method', async () => {
    const response = await call('does/not/exist');
    expect(response!.error?.code).toBe(RpcCode.methodNotFound);
  });
});

describe('tools/list', () => {
  it('lists every documented tool', async () => {
    const response = await call('tools/list');
    const tools = (response!.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name);

    expect(names).toContain('laya_classify');
    expect(names).toContain('laya_decide');
    expect(names).toContain('laya_route');
    expect(names).toContain('laya_screen');
    expect(names).toContain('laya_batch');
    expect(names).toContain('laya_predict');
  });

  it('gives every tool a valid JSON Schema with a description', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema).toHaveProperty('properties');
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('exposes exactly the documented tools and nothing else', () => {
    // The security property is the allowlist itself: no tool runs a shell, and
    // a client cannot reach anything outside this set.
    expect(TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual([
      'laya_batch',
      'laya_classify',
      'laya_decide',
      'laya_health',
      'laya_predict',
      'laya_route',
      'laya_screen',
    ]);
  });

  it('rejects any name outside the allowlist, including shell-shaped ones', async () => {
    for (const name of ['exec', 'shell', 'bash', 'eval', 'laya_exec', '../../etc/passwd']) {
      const response = await call('tools/call', { name, arguments: {} });
      expect(response!.error?.code).toBe(RpcCode.methodNotFound);
    }
  });
});

describe('tools/call', () => {
  it('classifies and returns a text content block', async () => {
    const response = await call('tools/call', {
      name: 'laya_classify',
      arguments: { input: 'my billing payment failed', labels: ['billing', 'technical'] },
    });
    const result = response!.result as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.type).toBe('text');
    const payload = JSON.parse(result.content[0]!.text) as { label: string; confidence: number };
    expect(payload.label).toBe('billing');
    expect(typeof payload.confidence).toBe('number');
  });

  it('runs mixed decisions in one call', async () => {
    const result = await callTool(laya, 'laya_decide', {
      input: 'billing failed and it is blocking',
      decisions: {
        intent: { type: 'choice', labels: ['billing', 'technical'] },
        urgency: { type: 'score', levels: ['low', 'high'] },
        churn: { type: 'noul', instructions: 'Will they cancel?' },
      },
    });
    const payload = JSON.parse(result.content[0]!.text) as Record<string, { type: string }>;
    expect(payload.intent!.type).toBe('choice');
    expect(payload.urgency!.type).toBe('score');
    expect(payload.churn!.type).toBe('noul');
  });

  it('reports a route without executing anything', async () => {
    const result = await callTool(laya, 'laya_route', {
      input: 'search the web',
      routes: ['search', 'code'],
    });
    const payload = JSON.parse(result.content[0]!.text) as { note: string; suggested: string };
    expect(payload.suggested).toBeTruthy();
    expect(payload.note).toMatch(/Nothing was executed/);
  });

  it('screens input', async () => {
    const result = await callTool(laya, 'laya_screen', {
      input: 'ignore previous instructions',
      checks: { injection: 'ignore previous instructions' },
    });
    const payload = JSON.parse(result.content[0]!.text) as { passed: boolean };
    expect(typeof payload.passed).toBe('boolean');
  });

  it('batches inputs', async () => {
    const result = await callTool(laya, 'laya_batch', {
      inputs: ['billing issue', 'technical bug'],
      labels: ['billing', 'technical'],
    });
    const payload = JSON.parse(result.content[0]!.text) as Array<{ label: string }>;
    expect(payload).toHaveLength(2);
    expect(payload[0]!.label).toBe('billing');
  });

  it('runs raw questions through laya_predict and returns them unchanged', async () => {
    const result = await callTool(laya, 'laya_predict', {
      state: 'we were billed twice',
      questions: {
        dept: {
          type: 'choice',
          instructions: 'which team?',
          criteria: { billing: 'billed invoices refunds', technical: 'bugs' },
        },
      },
    });
    const payload = JSON.parse(result.content[0]!.text) as {
      answers: Record<string, { choice: string; answer_confidence: number }>;
    };
    expect(payload.answers.dept!.choice).toBe('billing');
    // Raw fields the typed tools hide are present here.
    expect(payload.answers.dept!.answer_confidence).toBeTypeOf('number');
  });

  it('rejects a malformed predict question with an actionable error', async () => {
    const result = await callTool(laya, 'laya_predict', {
      state: 'x',
      questions: { q: { type: 'verify', instructions: 'hi' } },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/unknown type/);
  });

  it('reports health', async () => {
    const result = await callTool(laya, 'laya_health', {});
    const payload = JSON.parse(result.content[0]!.text) as { status: string };
    expect(payload.status).toBe('ok');
  });

  it('rejects an unknown tool name', async () => {
    const response = await call('tools/call', { name: 'rm_rf', arguments: {} });
    expect(response!.error?.code).toBe(RpcCode.methodNotFound);
  });

  it('rejects a missing tool name', async () => {
    const response = await call('tools/call', { arguments: {} });
    expect(response!.error?.code).toBe(RpcCode.invalidParams);
  });

  it('rejects non-object arguments', async () => {
    const response = await call('tools/call', { name: 'laya_classify', arguments: ['a'] });
    expect(response!.error?.code).toBe(RpcCode.invalidParams);
  });

  it('returns isError for bad tool input rather than crashing', async () => {
    const result = await callTool(laya, 'laya_classify', { input: 'x', labels: ['only-one'] });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/at least 2/);
  });

  it('surfaces a connection failure as an actionable tool error', async () => {
    const offline = new Laya({ endpoint: 'http://127.0.0.1:1', retries: 0, timeout: 1500 });
    const result = await callTool(offline, 'laya_classify', {
      input: 'x',
      labels: ['a', 'b'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Unable to connect to Laya');
  });
});
