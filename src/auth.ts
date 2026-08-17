import type { HttpClient } from './api.js';
import type { Config } from './config.js';

/** Path of the ClientLogin endpoint below the instance root. */
const CLIENT_LOGIN_PATH = '/api/greader.php/accounts/ClientLogin';
const TOKEN_PATH = '/api/greader.php/reader/api/0/token';

/**
 * Holds the two credentials the Google Reader API works with.
 *
 * - The **auth token** comes from `ClientLogin` and goes into every request as
 *   `Authorization: GoogleLogin auth=<token>`. FreshRSS derives it from the
 *   instance salt and the API password hash, so it stays valid until the
 *   password changes — caching it saves a login per call.
 * - The **write token** comes from `/token` and is sent as the form field `T`
 *   by the endpoints that modify data.
 *
 * Both are cached in memory only; nothing is written to disk.
 */
export class AuthSession {
  private auth: string | undefined;
  private write: string | undefined;
  /** Deduplicates concurrent logins triggered by parallel tool calls. */
  private authInFlight: Promise<string> | undefined;
  private writeInFlight: Promise<string> | undefined;

  constructor(
    private readonly config: Config,
    private readonly http: HttpClient
  ) {}

  async authToken(): Promise<string> {
    if (this.auth !== undefined) return this.auth;
    this.authInFlight ??= this.login().finally(() => {
      this.authInFlight = undefined;
    });
    return this.authInFlight;
  }

  async writeToken(): Promise<string> {
    if (this.write !== undefined) return this.write;
    this.writeInFlight ??= this.fetchWriteToken().finally(() => {
      this.writeInFlight = undefined;
    });
    return this.writeInFlight;
  }

  /** Drops both cached tokens, e.g. after a 401. */
  invalidate(): void {
    this.auth = undefined;
    this.write = undefined;
  }

  private async login(): Promise<string> {
    // POST, not GET: the password must not end up in the instance's access log.
    const form = new URLSearchParams({
      Email: this.config.user ?? '',
      Passwd: this.config.apiPassword ?? '',
    });
    const response = await this.http.send('POST', CLIENT_LOGIN_PATH, { form });
    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? 'FreshRSS rejected the login. FRESHRSS_API_PASSWORD must be the API ' +
              'password from the FreshRSS profile page (Settings → Profile → API ' +
              'management), not the web login password.'
          : response.status === 503
            ? 'FreshRSS reports the API as disabled. Enable it in Settings → ' +
              'Authentication → "Allow API access".'
            : `FreshRSS login failed with HTTP ${response.status}.`
      );
    }
    const token = parseClientLogin(response.text);
    if (token === undefined) {
      throw new Error(
        'FreshRSS answered the login without an Auth token. Check that ' +
          'FRESHRSS_URL points at the root of the FreshRSS instance.'
      );
    }
    this.auth = token;
    return token;
  }

  private async fetchWriteToken(): Promise<string> {
    const response = await this.http.send('GET', TOKEN_PATH, {
      headers: { Authorization: `GoogleLogin auth=${await this.authToken()}` },
    });
    if (!response.ok) {
      throw new Error(
        `FreshRSS refused to issue a write token (HTTP ${response.status}).`
      );
    }
    const token = response.text.trim();
    if (token === '') {
      throw new Error('FreshRSS returned an empty write token.');
    }
    this.write = token;
    return token;
  }
}

/**
 * Extracts the `Auth=` line from a ClientLogin response, which is plain text of
 * the shape `SID=…\nLSID=null\nAuth=user/<sha1>`.
 */
export function parseClientLogin(body: string): string | undefined {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Auth=')) {
      const value = trimmed.slice('Auth='.length);
      if (value !== '') return value;
    }
  }
  return undefined;
}
