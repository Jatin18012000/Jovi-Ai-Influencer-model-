import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mockExecutiveProposal } from '../../src/models/providers/mock-provider.js';

export type FakeApiMode = 'native-v1' | 'native-v0' | 'openai-compatible';

export interface FakeModel {
  id: string;
  type?: string;
  loaded?: boolean;
}

export interface ChatRequestBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
  response_format?: unknown;
  stream?: boolean;
}

export type ChatHandler = (body: ChatRequestBody) => { status?: number; json?: unknown; delayMs?: number };

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

/** Content that mimics a well-behaved local model answering the executive / evaluator prompts. */
export function defaultChat(body: ChatRequestBody): { json: unknown } {
  const system = body.messages.find((m) => m.role === 'system')?.content ?? '';
  const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
  let content: string;
  if (system.includes('independent evaluator')) {
    content = JSON.stringify({
      evaluations: ['A', 'B', 'C'].map((optionId, i) => ({
        optionId,
        scores: { quality: 4 - i, brandFit: 4, objectiveFit: 4 - i, originality: 3, audienceFit: 4, risk: 2, cost: 2 },
        strengths: ['clear hook'],
        concerns: [],
      })),
      recommendedOptionId: 'A',
      summary: 'Option A is the strongest introduction.',
    });
  } else {
    const goal = /<goal>([\s\S]*?)<\/goal>/.exec(user)?.[1] ?? 'goal';
    const proposal = mockExecutiveProposal(goal);
    // Real local models often wrap JSON in reasoning and fences.
    content = `<think>internal reasoning that must never be stored</think>\n\`\`\`json\n${JSON.stringify({
      ...proposal,
      interpretation: 'Introduce Jovi with curiosity: who is this AI creator?',
      rationaleSummary: 'Option A reveals the most personality in the fewest seconds.',
    })}\n\`\`\``;
  }
  return {
    json: {
      id: 'chatcmpl-fake',
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1500, completion_tokens: 700, total_tokens: 2200 },
    },
  };
}

/**
 * Minimal fake of LM Studio's local server: native model discovery
 * (/api/v1/models or /api/v0/models), OpenAI-compatible /v1/models, and
 * /v1/chat/completions. Real HTTP on 127.0.0.1 with a random port.
 */
export async function startFakeLMStudio(options: { apiMode?: FakeApiMode; models?: FakeModel[]; chat?: ChatHandler } = {}) {
  const state = {
    apiMode: options.apiMode ?? ('native-v1' as FakeApiMode),
    models: options.models ?? [{ id: 'qwen2.5-7b-instruct', type: 'llm', loaded: true }],
    chat: options.chat ?? (defaultChat as ChatHandler),
  };
  const requests: RecordedRequest[] = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as unknown) : null;
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (req.method === 'GET' && req.url === '/api/v1/models') {
        if (state.apiMode !== 'native-v1') return send(404, { error: 'Unexpected endpoint' });
        return send(200, {
          models: state.models.map((m) => ({
            type: m.type ?? 'llm',
            key: m.id,
            display_name: m.id,
            loaded_instances: m.loaded ? [{ id: m.id, config: { context_length: 4096 } }] : [],
            max_context_length: 32768,
          })),
        });
      }
      if (req.method === 'GET' && req.url === '/api/v0/models') {
        if (state.apiMode === 'openai-compatible') return send(404, { error: 'Unexpected endpoint' });
        return send(200, {
          object: 'list',
          data: state.models.map((m) => ({ id: m.id, object: 'model', type: m.type ?? 'llm', state: m.loaded ? 'loaded' : 'not-loaded' })),
        });
      }
      if (req.method === 'GET' && req.url === '/v1/models') {
        return send(200, { object: 'list', data: state.models.map((m) => ({ id: m.id, object: 'model', owned_by: 'organization_owner' })) });
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const result = state.chat(body as ChatRequestBody);
        const reply = () => send(result.status ?? 200, result.json ?? {});
        if (result.delayMs) setTimeout(reply, result.delayMs);
        else reply();
        return;
      }
      send(404, { error: `no route ${req.method} ${req.url}` });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    chatRequests: () => requests.filter((r) => r.url === '/v1/chat/completions').map((r) => r.body as ChatRequestBody),
    setModels: (models: FakeModel[]) => (state.models = models),
    setChat: (chat: ChatHandler) => (state.chat = chat),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A URL where nothing is listening (LM Studio not running). */
export async function closedPortUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/v1`;
}
