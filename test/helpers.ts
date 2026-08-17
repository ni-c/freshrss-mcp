import { vi, type MockInstance } from 'vitest';

import type { Config } from '../src/config.js';

export const BASE_URL = 'https://rss.example.com';
export const READER = `${BASE_URL}/api/greader.php/reader/api/0`;

export const testConfig: Config = {
  url: BASE_URL,
  user: 'tester',
  apiPassword: 'api-password',
  insecureTls: false,
  readOnly: false,
};

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
