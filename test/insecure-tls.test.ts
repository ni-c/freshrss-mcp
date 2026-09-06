import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpClient } from '../src/api.js';
import { testConfig } from './harness.js';

/**
 * Own file, because `vi.mock` is hoisted over the whole module: the other
 * suites need undici's real fetch left alone.
 */
vi.mock('undici', async (original) => {
  const actual = await original<typeof import('undici')>();
  return { ...actual, fetch: vi.fn() };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FRESHRSS_INSECURE_TLS', () => {
  it('sends through undici with its own dispatcher, and only then', async () => {
    const undici = await import('undici');
    const undiciFetch = vi.mocked(undici.fetch);
    undiciFetch.mockResolvedValue(new undici.Response('ok') as never);
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok'));

    const insecure = new HttpClient(testConfig({ insecureTls: true }));
    expect((await insecure.send('GET', '/x')).text).toBe('ok');
    expect(undiciFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
    const init = undiciFetch.mock.calls[0]?.[1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBeInstanceOf(undici.Agent);

    const secure = new HttpClient(testConfig());
    await secure.send('GET', '/x');
    expect(undiciFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });
});
