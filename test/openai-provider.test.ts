// OpenAIProvider against a local mock of the Responses API: request shape and response handling.
// (The live API is exercised by `npm run smoke`.)

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { InterpretResultSchema } from '../src/domain/schemas.ts';
import { OpenAIProvider } from '../src/llm/openai.ts';
import { LLMError } from '../src/llm/provider.ts';

async function withMockServer(reply: (body: any) => { status?: number; json: unknown }, fn: (baseURL: string, bodies: any[]) => Promise<void>) {
  const bodies: any[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push({ path: req.url, ...body });
    const r = reply(body);
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.json));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}/v1`, bodies);
  } finally {
    server.close();
  }
}

const response = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 'resp_test', object: 'response', created_at: 0, status: 'completed', model: 'gpt-test', incomplete_details: null,
  output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content }],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, ...extra,
});

const request = { task: 'interpret' as const, system: 'SYS', user: 'USER', schemaName: 'interpretation', schema: InterpretResultSchema };

test('sends a strict json_schema Responses request and returns the raw output text', async () => {
  await withMockServer(() => ({ json: response([{ type: 'output_text', text: '{"ok":true}', annotations: [] }]) }), async (baseURL, bodies) => {
    const p = new OpenAIProvider({ apiKey: 'test', model: 'gpt-test', baseURL, maxRetries: 0 });
    const r = await p.complete(request);
    assert.equal(r.rawText, '{"ok":true}');
    assert.equal(r.model, 'gpt-test');

    const body = bodies[0];
    assert.equal(body.path, '/v1/responses');
    assert.equal(body.model, 'gpt-test');
    assert.equal(body.instructions, 'SYS');
    assert.equal(body.input, 'USER');
    assert.equal(body.store, false);
    assert.equal(body.reasoning.effort, 'low');
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.name, 'interpretation');
    const schema = body.text.format.schema;
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, Object.keys(schema.properties));
    assert.ok(!JSON.stringify(schema).includes('"maximum"'), 'unsupported constraints stripped');
  });
});

test('refusals and incomplete responses surface as LLMError', async () => {
  await withMockServer(() => ({ json: response([{ type: 'refusal', refusal: 'no' }]) }), async (baseURL) => {
    const p = new OpenAIProvider({ apiKey: 'test', baseURL, maxRetries: 0 });
    await assert.rejects(p.complete(request), (e: unknown) => e instanceof LLMError && e.kind === 'refusal');
  });
  await withMockServer(() => ({ json: response([], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }) }), async (baseURL) => {
    const p = new OpenAIProvider({ apiKey: 'test', baseURL, maxRetries: 0 });
    await assert.rejects(p.complete(request), (e: unknown) => e instanceof LLMError && e.kind === 'incomplete');
  });
  await withMockServer(() => ({ status: 401, json: { error: { message: 'bad key', type: 'invalid_request_error' } } }), async (baseURL) => {
    const p = new OpenAIProvider({ apiKey: 'test', baseURL, maxRetries: 0 });
    await assert.rejects(p.complete(request), (e: unknown) => e instanceof LLMError && e.kind === 'http_401');
  });
});

test('missing API key is a configuration error', () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.throws(() => new OpenAIProvider(), (e: unknown) => e instanceof LLMError && e.kind === 'config');
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});
