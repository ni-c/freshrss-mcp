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

describe('ELICITATION', () => {
  it('defaults to on, and to on for an empty value', () => {
    // The only variable of this family that defaults to *on*. An unset switch
    // has to mean "ask", or a deployment that never heard of it would quietly
    // stop asking.
    expect(loadConfig(env({ ...complete })).elicitation).toBe(true);
    expect(loadConfig(env({ ...complete, ELICITATION: '' })).elicitation).toBe(
      true
    );
  });

  it('is switched off by "false", in any casing or padding', () => {
    for (const raw of ['false', 'FALSE', ' False ']) {
      expect(
        loadConfig(env({ ...complete, ELICITATION: raw })).elicitation,
        raw
      ).toBe(false);
    }
  });

  it('refuses to start on anything else, naming both valid values', () => {
    // Deliberately fatal rather than falling back to the default: a typo would
    // leave the dialog running while the operator believes it is off, and
    // nothing else would ever tell them.
    for (const raw of ['1', 'off', 'no']) {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('exit');
      }) as never);
      expect(() => loadConfig(env({ ...complete, ELICITATION: raw }))).toThrow(
        'exit'
      );
      expect(exit).toHaveBeenCalledWith(1);
      const message = String(error.mock.calls[0]?.[0] ?? '');
      expect(message, raw).toContain('ELICITATION');
      expect(message, raw).toContain('"true"');
      expect(message, raw).toContain('"false"');
      vi.restoreAllMocks();
    }
  });

  it('has already wiped the credential by the time it can exit', () => {
    // parseElicitation sits *after* the delete on purpose. An exit above it
    // would leave the credential in the environment for whatever a crash
    // reporter or an inspector does next — which is exactly what that delete
    // exists to prevent, and its comment says so.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const e = env({ ...complete, ELICITATION: 'nonsense' });
    expect(() => loadConfig(e)).toThrow('exit');
    expect(e.FRESHRSS_API_PASSWORD).toBeUndefined();
    vi.restoreAllMocks();
  });
});

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
