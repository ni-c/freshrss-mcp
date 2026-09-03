/**
 * What this repository still has to prove about the SSRF guard.
 *
 * The classifier lives in `mcp-internal-hosts` and is tested there: the
 * IPv4-mapped IPv6 literals of the reported bypass (GHSA-qqh2-7466-82f8), the
 * metadata endpoints, scope ids, the root label, every spelling of loopback.
 * Repeating that here would test the dependency.
 *
 * What only this repository can assert is the decision it makes on the answer —
 * the library reports which hosts are internal and deliberately refuses to
 * decide what follows. Everything below is about that: the refusal FreshRSS
 * raises, the cases it lets through on purpose, and the work it does not do.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertRoutableHosts } from '../src/hosts.js';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup }));

afterEach(() => {
  vi.restoreAllMocks();
  lookup.mockReset();
});

describe('assertRoutableHosts', () => {
  it('refuses a name that resolves to loopback', async () => {
    lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(
      assertRoutableHosts(['feed.attacker.example'])
    ).rejects.toThrow(/loopback and link-local/);
  });

  it('refuses a name whose second address is the metadata service', async () => {
    lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    await expect(
      assertRoutableHosts(['feed.attacker.example'])
    ).rejects.toThrow(/link-local/);
  });

  it('names the address rather than the hostname in the refusal', async () => {
    // An operator reading the message has to be able to tell why: the name
    // looked ordinary, and it was the record behind it that was not.
    lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(
      assertRoutableHosts(['feed.attacker.example'])
    ).rejects.toThrow(/169\.254\.169\.254/);
  });

  it('allows a name that resolves to a routable address', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(
      assertRoutableHosts(['news.example.com'])
    ).resolves.toBeUndefined();
  });

  it('allows a name it cannot resolve, which FreshRSS may still reach', async () => {
    // Fail-open on purpose: the FreshRSS server may sit in a different network
    // with its own resolver. SECURITY.md says so, and this is the test that
    // keeps it true.
    lookup.mockRejectedValue(
      Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    );
    await expect(
      assertRoutableHosts(['rss.internal.example'])
    ).resolves.toBeUndefined();
  });

  it('does not read a sinkholed name as loopback', async () => {
    // Every ad blocker answers 0.0.0.0 for a blocked domain. That is the
    // resolver declining, not the name addressing the FreshRSS host — reading
    // it as loopback would make every blocklisted domain unsubscribable.
    lookup.mockResolvedValue([{ address: '0.0.0.0', family: 4 }]);
    await expect(
      assertRoutableHosts(['ads.example.com'])
    ).resolves.toBeUndefined();
  });

  it('still refuses 0.0.0.0 given as a literal', async () => {
    await expect(assertRoutableHosts(['0.0.0.0'])).rejects.toThrow(/loopback/);
  });

  it('decides a literal without asking the resolver', async () => {
    await expect(assertRoutableHosts(['1.1.1.1'])).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses a literal before any name in the same batch is resolved', async () => {
    await expect(
      assertRoutableHosts(['news.example.com', '[::ffff:169.254.169.254]'])
    ).rejects.toThrow(/link-local/);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('resolves each distinct name once', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await assertRoutableHosts([
      'a.example.com',
      'a.example.com',
      'b.example.com',
    ]);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('stops resolving once one host has been refused', async () => {
    // The reason this needs mcp-internal-hosts 0.2.0 rather than 0.1.0. An OPML
    // document may name thousands of feeds; if an early one points at
    // 127.0.0.1 the answer is already known, and resolving the rest would spend
    // the whole ten-second budget to arrive at the same refusal.
    lookup.mockImplementation(async (name: string) =>
      name === 'bad.example.com'
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }]
    );
    const many = [
      'bad.example.com',
      ...Array.from({ length: 200 }, (_, i) => `feed${i}.example.com`),
    ];
    await expect(assertRoutableHosts(many)).rejects.toThrow(/loopback/);
    // The batch already in flight finishes, so this is not exactly one — but it
    // is the first batch rather than all two hundred names.
    expect(lookup.mock.calls.length).toBeLessThanOrEqual(8);
  });
});
