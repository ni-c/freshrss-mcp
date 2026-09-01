import { assertLoopback, waitForHttp } from 'mcp-integration-harness';

/**
 * Waits for the throwaway FreshRSS and hands back the environment.
 *
 * Short, because `compose.yml` does the work: FreshRSS's first request is
 * otherwise a five-step browser wizard, and its `FRESHRSS_INSTALL` /
 * `FRESHRSS_USER` variables run the CLI installer instead. Three of those
 * flags are load-bearing and none of them are obvious:
 *
 *  - **`--api_enabled`** is what the GReader endpoint hangs off. Without it
 *    every API call answers HTTP 503, which reads like the server being down
 *    rather than like a setting being off.
 *  - **`--api_password` is not `--password`.** The account password signs in
 *    to the web interface; the API password is a separate value, and using the
 *    account one gets a 401 that says nothing about which of the two it wanted.
 *  - **`--base_url`** has to match the URL the suite uses, or FreshRSS builds
 *    absolute links that point somewhere else.
 *
 * The feed the suite subscribes to is served by a second container on the
 * compose network. FreshRSS's own default subscription points at github.com,
 * which would make every run depend on somebody else's uptime — and fail on a
 * machine with no outbound internet, for a reason that has nothing to do with
 * this server.
 */

export const USER = 'integration';
export const API_PASSWORD = 'integration-api-not-a-secret';

/** Reachable from the FreshRSS container, and from nowhere else. */
export const FEED_URL = 'http://feed/atom.xml';
export const FEED_TITLE = 'Integration Feed';
/** In the fixture feed's newest article body. */
export const MARKER = 'PINEAPPLE';

export interface Sandbox {
  url: string;
  env: Record<string, string>;
}

export async function bootstrap(
  url = 'http://127.0.0.1:8081'
): Promise<Sandbox> {
  assertLoopback(url);
  await waitForHttp(url, { timeoutSeconds: 240 });

  // The installer runs at container start and takes a while; the API answering
  // a login is the readiness signal, not the port.
  const api = `${url}/api/greader.php/accounts/ClientLogin`;
  const deadline = Date.now() + 180_000;
  for (;;) {
    const response = await fetch(
      `${api}?Email=${USER}&Passwd=${encodeURIComponent(API_PASSWORD)}`,
      { signal: AbortSignal.timeout(10_000) }
    );
    const body = await response.text();
    if (response.ok && body.includes('Auth=')) break;
    if (Date.now() >= deadline) {
      throw new Error(
        `FreshRSS never accepted an API login (HTTP ${response.status}). ` +
          'A 503 means the API is switched off — `--api_enabled` in ' +
          'FRESHRSS_INSTALL. A 401 usually means the *account* password was ' +
          'used instead of `--api_password`, which is a different value. ' +
          `Body: ${body.slice(0, 200)}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  return {
    url,
    env: {
      FRESHRSS_URL: url,
      FRESHRSS_USER: USER,
      FRESHRSS_API_PASSWORD: API_PASSWORD,
      // Defaults to true in this server; the suite exists to drive the writes.
      FRESHRSS_READ_ONLY: 'false',
    },
  };
}
