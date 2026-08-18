import { describe, expect, it, vi } from 'vitest';

import { loadConfig, missingConfigKeys } from '../src/config.js';

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return { ...values } as NodeJS.ProcessEnv;
}

const complete = {
  FRESHRSS_URL: 'https://rss.example.com',
  FRESHRSS_USER: 'tester',
  FRESHRSS_API_PASSWORD: 'secret',
};

describe('loadConfig', () => {
  it('starts without credentials so tools stay listable', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = loadConfig(env({}));
    expect(config.url).toBeUndefined();
    expect(missingConfigKeys(config)).toEqual([
      'FRESHRSS_URL',
      'FRESHRSS_USER',
      'FRESHRSS_API_PASSWORD',
    ]);
    spy.mockRestore();
  });

  it('names only the missing variables', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = loadConfig(
      env({ FRESHRSS_URL: 'https://rss.example.com', FRESHRSS_USER: 'tester' })
    );
    expect(missingConfigKeys(config)).toEqual(['FRESHRSS_API_PASSWORD']);
    spy.mockRestore();
  });

  it('deletes the API password from the environment after reading it', () => {
    const e = env(complete);
    const config = loadConfig(e);
    expect(config.apiPassword).toBe('secret');
    expect(e.FRESHRSS_API_PASSWORD).toBeUndefined();
  });

  it('deletes the password even when the URL is missing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = env({ FRESHRSS_API_PASSWORD: 'secret' });
    loadConfig(e);
    expect(e.FRESHRSS_API_PASSWORD).toBeUndefined();
    spy.mockRestore();
  });

  it('strips trailing slashes from the base URL', () => {
    const config = loadConfig(
      env({ ...complete, FRESHRSS_URL: 'https://rss.example.com//' })
    );
    expect(config.url).toBe('https://rss.example.com');
  });

  it('rejects a URL containing credentials', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    expect(() =>
      loadConfig(
        env({ ...complete, FRESHRSS_URL: 'https://user:pw@rss.example.com' })
      )
    ).toThrow('exit');
    exit.mockRestore();
    spy.mockRestore();
  });

  it('rejects a non-http protocol', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    expect(() =>
      loadConfig(env({ ...complete, FRESHRSS_URL: 'file:///etc/passwd' }))
    ).toThrow('exit');
    exit.mockRestore();
    spy.mockRestore();
  });

  it('warns about plain http to a remote host but keeps going', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = loadConfig(
      env({ ...complete, FRESHRSS_URL: 'http://rss.example.com' })
    );
    expect(config.url).toBe('http://rss.example.com');
    expect(spy.mock.calls.flat().join(' ')).toMatch(/unencrypted/);
    spy.mockRestore();
  });

  it('does not warn about plain http to loopback in any notation', () => {
    // Regression: URL.hostname returns "[::1]" with the brackets, so comparing
    // against a bare "::1" never matched and this warned about a loopback URL as
    // if the API password were going over the network.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const url of [
      'http://localhost:8013',
      'http://127.0.0.1:8013',
      'http://[::1]:8013',
    ]) {
      loadConfig(env({ ...complete, FRESHRSS_URL: url }));
      expect(spy.mock.calls.flat().join(' '), url).not.toMatch(/unencrypted/);
    }
    spy.mockRestore();
  });

  it('reads the optional flags', () => {
    const config = loadConfig(
      env({
        ...complete,
        FRESHRSS_READ_ONLY: 'true',
        FRESHRSS_INSECURE_TLS: 'true',
      })
    );
    expect(config.readOnly).toBe(true);
    expect(config.insecureTls).toBe(true);
  });
});
