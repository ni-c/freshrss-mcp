import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { vi, type MockInstance } from 'vitest';

import type { Config } from '../src/config.js';
import { createServer } from '../src/server.js';

export const BASE_URL = 'https://rss.example.com';
export const READER = `${BASE_URL}/api/greader.php/reader/api/0`;

/**
 * A function rather than a shared object, and the reason is not style.
 *
 * As a const it had no `elicitation` field — not optional since the
 * human-in-the-loop pass — and nothing noticed, because `tsconfig.json` covers
 * `src` and not `test`. A single mutable object shared across a suite is also
 * one edit away from a test that only passes in a particular order.
 */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    url: BASE_URL,
    user: 'tester',
    apiPassword: 'api-password',
    insecureTls: false,
    readOnly: false,
    elicitation: true,
    allowTools: undefined,
    denyTools: undefined,
    ...overrides,
  };
}

export interface RecordedCall {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
  /** Parsed body for the form-encoded requests, which is most of them. */
  form: URLSearchParams;
}

export interface FetchStub {
  spy: MockInstance;
  calls: RecordedCall[];
  /** Calls against the reader API, i.e. without the login and token requests. */
  readerCalls: RecordedCall[];
}

/** Route table: exact path (without query) → body, or a function. */
export type Routes = Record<
  string,
  string | ((call: RecordedCall) => string | Response)
>;

/**
 * Replaces global fetch with a stub that speaks just enough of the FreshRSS API:
 * ClientLogin and /token are answered automatically, everything else comes from
 * `routes`. An unrouted path fails the test loudly instead of returning
 * something plausible.
 */
export function stubFreshRss(routes: Routes = {}): FetchStub {
  const calls: RecordedCall[] = [];
  const spy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = typeof init?.body === 'string' ? init.body : '';
        const call: RecordedCall = {
          url,
          method: init?.method ?? 'GET',
          body,
          headers: (init?.headers as Record<string, string>) ?? {},
          form: new URLSearchParams(body),
        };
        calls.push(call);

        const path = new URL(url).pathname;
        if (path.endsWith('/accounts/ClientLogin')) {
          return new Response('SID=tester/abc\nLSID=null\nAuth=tester/abc\n', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          });
        }
        if (path.endsWith('/reader/api/0/token')) {
          return new Response(`${'w'.repeat(57)}\n`, { status: 200 });
        }

        const key = path.replace('/api/greader.php/reader/api/0', '');
        const route = routes[key];
        if (route === undefined) {
          throw new Error(`test stub: no route for ${call.method} ${key}`);
        }
        const result = typeof route === 'function' ? route(call) : route;
        return result instanceof Response
          ? result
          : new Response(result, {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
      }
    );

  return {
    spy,
    calls,
    get readerCalls() {
      return calls.filter(
        (c) =>
          !c.url.includes('/accounts/ClientLogin') &&
          !c.url.endsWith('/reader/api/0/token')
      );
    },
  };
}

/** A single article as FreshRSS returns it from `stream/contents`. */
export function rawEntry(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'tag:google.com,2005:reader/item/0006218f8a2b1c40',
    crawlTimeMsec: '1755388800000',
    timestampUsec: '1755388800000000',
    published: 1755388800,
    title: 'A headline',
    canonical: [{ href: 'https://news.example.com/a' }],
    alternate: [{ href: 'https://news.example.com/a' }],
    categories: [
      'user/-/state/com.google/reading-list',
      'user/-/label/News',
      'user/-/state/org.freshrss/main',
    ],
    origin: {
      streamId: 'feed/12',
      title: 'Example News',
      htmlUrl: 'https://news.example.com',
    },
    summary: { content: '<p>Hello <b>world</b>.</p>' },
    author: 'Jane Doe',
    ...overrides,
  };
}

/** How a client that can show a dialog answers it. */
export type ElicitBehaviour = 'accept' | 'decline' | 'cancel';

/**
 * Connects a client to the real server.
 *
 * Without `elicit` the client declares no elicitation capability, which is the
 * case the two-call token exists for and what most tests here drive. With it,
 * the client answers the dialog and `prompts` records what the server put in
 * front of the user.
 */
export async function connect(
  overrides: Partial<Config> = {},
  elicit?: ElicitBehaviour
): Promise<Client & { prompts: string[] }> {
  const server = createServer(testConfig(overrides));
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const prompts: string[] = [];
  const client = new Client(
    { name: 'test', version: '0.0.0' },
    elicit === undefined ? {} : { capabilities: { elicitation: {} } }
  );
  if (elicit !== undefined) {
    client.setRequestHandler('elicitation/create', (request) => {
      const params = request.params as { message?: string };
      prompts.push(params.message ?? '');
      if (elicit === 'cancel') return { action: 'cancel' };
      if (elicit === 'decline') return { action: 'decline' };
      return { action: 'accept', content: { confirm: true } };
    });
  }
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return Object.assign(client, { prompts });
}

/** The tools a server built with this configuration actually offers. */
export async function toolNames(
  overrides: Partial<Config> = {}
): Promise<string[]> {
  const client = await connect(overrides);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((tool) => tool.name).sort();
}

/** The text of the first content block. */
export function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('no text content');
  return first.text;
}

/** The whole content array as JSON, for asserting on its shape. */
export function contentOf(result: CallToolResult): string {
  return JSON.stringify(result.content);
}

export function dataOf(result: CallToolResult): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

/** The confirmation token a guarded tool handed back on its first call. */
export function tokenOf(result: CallToolResult): string {
  const match = /confirm_token=\\?"([0-9a-f]+)/.exec(textOf(result));
  if (match?.[1] === undefined) {
    throw new Error(
      `no confirm_token in the result — did the client declare elicitation? ` +
        `Got: ${textOf(result).slice(0, 300)}`
    );
  }
  return match[1];
}

/**
 * Runs a guarded tool through both halves of its two-call token.
 *
 * Takes the client rather than living on what `connect` returns, so the
 * signature matches every other repository in this family. Only meaningful on
 * a client that declared no elicitation: with a dialog available the server
 * asks instead of offering a token, which is the point of the dialog.
 */
export async function confirmed(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<CallToolResult> {
  const first = (await client.callTool({
    name,
    arguments: args,
  })) as CallToolResult;
  return client.callTool({
    name,
    arguments: { ...args, confirm_token: tokenOf(first) },
  }) as Promise<CallToolResult>;
}
