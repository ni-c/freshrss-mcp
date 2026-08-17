import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpClient } from '../src/api.js';
import { AuthSession, parseClientLogin } from '../src/auth.js';
import { stubFreshRss, testConfig } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseClientLogin', () => {
  it('picks the Auth line out of the plain text response', () => {
    expect(
      parseClientLogin('SID=tester/abc\nLSID=null\nAuth=tester/abc\n')
    ).toBe('tester/abc');
  });

  it('returns undefined when there is no Auth line', () => {
    expect(parseClientLogin('SID=x\nLSID=null\n')).toBeUndefined();
    expect(parseClientLogin('Auth=\n')).toBeUndefined();
  });
});

describe('AuthSession', () => {
  it('logs in via POST so the password stays out of the access log', async () => {
    const stub = stubFreshRss();
    const session = new AuthSession(testConfig, new HttpClient(testConfig));
    expect(await session.authToken()).toBe('tester/abc');

    const login = stub.calls[0];
    expect(login?.method).toBe('POST');
    expect(login?.url).not.toMatch(/Passwd/);
    expect(login?.form.get('Email')).toBe('tester');
    expect(login?.form.get('Passwd')).toBe('api-password');
  });

  it('caches the token instead of logging in per call', async () => {
    const stub = stubFreshRss();
    const session = new AuthSession(testConfig, new HttpClient(testConfig));
    await session.authToken();
    await session.authToken();
    expect(stub.calls).toHaveLength(1);
  });

  it('deduplicates concurrent logins', async () => {
    const stub = stubFreshRss();
    const session = new AuthSession(testConfig, new HttpClient(testConfig));
    await Promise.all([
      session.authToken(),
      session.authToken(),
      session.authToken(),
    ]);
    expect(stub.calls).toHaveLength(1);
  });

  it('logs in again after invalidate()', async () => {
    const stub = stubFreshRss();
    const session = new AuthSession(testConfig, new HttpClient(testConfig));
    await session.authToken();
    session.invalidate();
    await session.authToken();
    expect(stub.calls).toHaveLength(2);
  });

  it('fetches the separate write token', async () => {
    stubFreshRss();
    const session = new AuthSession(testConfig, new HttpClient(testConfig));
    expect(await session.writeToken()).toBe('w'.repeat(57));
  });

  it('explains a 401 in terms of the API password', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Unauthorized!', { status: 401 })
    );
    const session = new AuthSession(testConfig, new HttpClient(testConfig));
    await expect(session.authToken()).rejects.toThrow(/API password/);
  });

  it('explains a 503 as a disabled API', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Service Unavailable!', { status: 503 })
    );
    const session = new AuthSession(testConfig, new HttpClient(testConfig));
    await expect(session.authToken()).rejects.toThrow(/API access/);
  });

  it('rejects a login response without a token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>login page</html>', { status: 200 })
    );
    const session = new AuthSession(testConfig, new HttpClient(testConfig));
    await expect(session.authToken()).rejects.toThrow(/root of the FreshRSS/);
  });
});

describe('HttpClient', () => {
  it('never follows redirects, which would leak the credentials', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));
    await new HttpClient(testConfig).send('GET', '/x');
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeDefined();
  });
});
