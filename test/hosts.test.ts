/**
 * Tests for the host classifier behind the SSRF guard.
 *
 * The cases with an IPv4-mapped IPv6 literal are the reported bypass
 * (GHSA-qqh2-7466-82f8): `URL` hands the guard `[::ffff:7f00:1]`, the old
 * string comparison saw nothing it knew, and every dual-stack client dials it
 * as 127.0.0.1. A failure here means that door is open again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertRoutableHosts, internalHostKind } from '../src/hosts.js';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup }));

afterEach(() => {
  vi.restoreAllMocks();
  lookup.mockReset();
});

/** What `new URL(...).hostname` yields for each of these, brackets included. */
function hostnameOf(url: string): string {
  return new URL(url).hostname;
}

describe('internalHostKind', () => {
  it.each([
    // Plain literals — the cases the original guard already caught.
    ['http://127.0.0.1/feed', 'loopback'],
    ['http://127.42.9.1/feed', 'loopback'],
    ['http://0.0.0.0/feed', 'loopback'],
    ['http://localhost:8080/feed', 'loopback'],
    ['http://admin.localhost/feed', 'loopback'],
    ['http://[::1]/feed', 'loopback'],
    ['http://[::]/feed', 'loopback'],
    ['http://169.254.169.254/latest/meta-data/', 'link-local'],
    ['http://[fe80::1]/feed', 'link-local'],
    ['http://[febf::1]/feed', 'link-local'],
    // The reported bypass: IPv4-mapped IPv6, which URL rewrites into hex.
    ['http://[::ffff:127.0.0.1]/feed', 'loopback'],
    ['http://[::ffff:169.254.169.254]/latest/meta-data/', 'link-local'],
    ['http://[0:0:0:0:0:ffff:7f00:1]/feed', 'loopback'],
    // IPv4-compatible, IPv4-translated and the well-known NAT64 prefix, which
    // carry an IPv4 address the same way.
    ['http://[::127.0.0.1]/feed', 'loopback'],
    ['http://[::ffff:0:169.254.169.254]/feed', 'link-local'],
    ['http://[64:ff9b::169.254.169.254]/feed', 'link-local'],
    // A trailing root label is the same name, and was a second way past the
    // string comparison.
    ['http://localhost./feed', 'loopback'],
    ['http://LOCALHOST/feed', 'loopback'],
  ])('classifies %s as %s', (url, kind) => {
    expect(internalHostKind(hostnameOf(url))).toBe(kind);
  });

  it.each([
    // Private LAN stays allowed on purpose: a self-hosted FreshRSS subscribes
    // to feeds on its own network, and refusing that breaks the normal case.
    'http://192.168.1.50/rss.xml',
    'http://10.0.0.5/rss.xml',
    'http://172.16.4.4/rss.xml',
    'http://[fc00::1]/rss.xml',
    'http://[fec0::1]/rss.xml',
    'https://news.example.com/rss',
    'https://1.1.1.1/rss',
    'https://[2606:4700::1111]/rss',
    'https://127.0.0.1.example.com/rss',
    'https://notlocalhost/rss',
  ])('leaves %s alone', (url) => {
    expect(internalHostKind(hostnameOf(url))).toBeNull();
  });

  // `URL` always hands over the compressed hex form, but the classifier is
  // exported and takes a hostname from anywhere — including a DNS answer, which
  // is where the dotted-quad spellings actually arrive.
  it.each([
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['::127.0.0.1', 'loopback'],
    ['0:0:0:0:0:ffff:a9fe:a9fe', 'link-local'],
    ['[::ffff:127.0.0.1]', 'loopback'],
    ['FE80::1', 'link-local'],
  ])('classifies the bare literal %s as %s', (host, kind) => {
    expect(internalHostKind(host)).toBe(kind);
  });

  it.each([
    '::ffff:1.1.1.1',
    '2606:4700:4700::1111',
    'not a host at all',
    '',
    '1:2:3:4:5:6:7:8:9',
  ])('leaves the bare literal %j alone', (host) => {
    expect(internalHostKind(host)).toBeNull();
  });
});

describe('metadata endpoints and scope ids', () => {
  it.each([
    ['100.100.100.200', 'link-local'],
    ['192.0.0.192', 'link-local'],
  ])('refuses the metadata endpoint %s', (host, kind) => {
    expect(internalHostKind(host)).toBe(kind);
  });

  it.each([
    ['::ffff:127.0.0.1%lo', 'loopback'],
    ['::ffff:169.254.169.254%eth0', 'link-local'],
    ['fe80::1%eth0', 'link-local'],
    ['::%lo', 'loopback'],
  ])('reads %s despite the scope id', (host, kind) => {
    expect(internalHostKind(host)).toBe(kind);
  });
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

  it('allows a name that resolves to a routable address', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(
      assertRoutableHosts(['news.example.com'])
    ).resolves.toBeUndefined();
  });

  it('allows a name it cannot resolve, which FreshRSS may still reach', async () => {
    lookup.mockRejectedValue(
      Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    );
    await expect(
      assertRoutableHosts(['rss.internal.example'])
    ).resolves.toBeUndefined();
  });

  it('does not read a sinkholed name as loopback', async () => {
    // Every ad blocker answers 0.0.0.0 for a blocked domain. That is the
    // resolver declining, not the name addressing the FreshRSS host.
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
});
