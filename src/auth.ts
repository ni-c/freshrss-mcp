import type { HttpClient } from './api.js';
import type { Config } from './config.js';

/** Path of the ClientLogin endpoint below the instance root. */
const CLIENT_LOGIN_PATH = '/api/greader.php/accounts/ClientLogin';
const TOKEN_PATH = '/api/greader.php/reader/api/0/token';

/**
 * Visible ASCII, bounded: what a token the instance hands out may look like
 * before it goes back out in a request. FreshRSS writes `user/<sha1>` for the
 * auth token and a 57-character string for the write token; the shape leaves
 * room for both and for nothing that undici would refuse in a header value —
 * because undici's refusal quotes the value, the instance's string, verbatim
 * into a `TypeError` that reached the model.
 */
export const TOKEN_SHAPE = /^[!-~]{1,1024}$/;

/**
 * How long a refused login is repeated from memory before FreshRSS is asked
 * again.
 *
 * Every tool call that needs a token is a `ClientLogin` when none is cached,
 * and FreshRSS writes every refused one into its log as `Password API
 * mismatch for user …`. `get_user_info` is annotated read-only, idempotent
 * and cheap, and its 401 answer says "check the password" — which is what a
 * model retries. A wrong password in the configuration then becomes a burst
 * of failed logins in the instance's log, and a reverse proxy's rate limit or
 * a fail2ban jail keyed on that line locks the operator's own address out.
 * Ten seconds turns the burst into one line per ten seconds; the answer in
 * between is the same answer, and says that it is remembered.
 */
export const LOGIN_COOLDOWN_MS = 10_000;

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
  /** The last refused login, repeated until `refusedUntil`. */
  private refusal: Error | undefined;
  private refusedUntil = 0;

  constructor(
    private readonly config: Config,
    private readonly http: HttpClient
  ) {}

  async authToken(): Promise<string> {
    if (this.auth !== undefined) return this.auth;
    if (this.refusal !== undefined && Date.now() < this.refusedUntil) {
      throw this.rememberedRefusal();
    }
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

  /**
   * Drops both cached tokens, e.g. after a 401. A remembered refusal stays:
   * the retry that follows a 401 must not be the second failed login within
   * the same second.
   */
  invalidate(): void {
    this.auth = undefined;
    this.write = undefined;
  }

  private rememberedRefusal(): Error {
    const next = new Date(this.refusedUntil).toISOString();
    return new Error(
      `${(this.refusal as Error).message} (Repeated from memory: a refused ` +
        `login is not retried for ${LOGIN_COOLDOWN_MS / 1000} seconds, so a ` +
        'wrong password cannot become a burst of failed logins in the ' +
        `instance's log. The next attempt is possible at ${next}.)`
    );
  }

  private async login(): Promise<string> {
    // POST, not GET: the password must not end up in the instance's access log.
    const form = new URLSearchParams({
      Email: this.config.user ?? '',
      Passwd: this.config.apiPassword ?? '',
    });
    const response = await this.http.send('POST', CLIENT_LOGIN_PATH, { form });
    if (!response.ok) {
      const refusal = new Error(
        response.status === 401
          ? 'FreshRSS rejected the login. FRESHRSS_API_PASSWORD must be the API ' +
              'password from the FreshRSS profile page (Settings → Profile → API ' +
              'management), not the web login password.'
          : response.status === 503
            ? 'FreshRSS reports the API as disabled. Enable it in Settings → ' +
              'Authentication → "Allow API access".'
            : `FreshRSS login failed with HTTP ${response.status}.`
      );
      // Every refused login is a line in the instance's log, whatever the
      // status; all of them are remembered for the cooldown.
      this.refusal = refusal;
      this.refusedUntil = Date.now() + LOGIN_COOLDOWN_MS;
      throw refusal;
    }
    const token = parseClientLogin(response.text);
    if (token === undefined) {
      throw new Error(
        'FreshRSS answered the login without a usable Auth token. Check that ' +
          'FRESHRSS_URL points at the root of the FreshRSS instance.'
      );
    }
    this.refusal = undefined;
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
    // The shape, not just non-emptiness: the token rides in every write as a
    // form field, and a body of megabytes — or of anything but a token — is
    // not one.
    if (!TOKEN_SHAPE.test(token)) {
      throw new Error(
        token === ''
          ? 'FreshRSS returned an empty write token.'
          : 'FreshRSS returned something that is not a write token.'
      );
    }
    this.write = token;
    return token;
  }
}

/**
 * Extracts the `Auth=` line from a ClientLogin response, which is plain text of
 * the shape `SID=…\nLSID=null\nAuth=user/<sha1>`.
 *
 * Only a value of {@link TOKEN_SHAPE} is a token. Anything else — a carriage
 * return in the middle, a NUL, a line of megabytes — went into the
 * `Authorization` header as it came, and undici's refusal quoted it back into
 * the model's context as `Headers.append: "…" is an invalid header value`.
 */
export function parseClientLogin(body: string): string | undefined {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Auth=')) {
      const value = trimmed.slice('Auth='.length);
      if (TOKEN_SHAPE.test(value)) return value;
    }
  }
  return undefined;
}
