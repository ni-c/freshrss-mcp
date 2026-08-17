import {
  Agent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from 'undici';

import { AuthSession } from './auth.js';
import {
  missingConfigKeys,
  missingConfigMessage,
  type Config,
} from './config.js';

/** Default per-request timeout. */
export const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Timeout for calls that make FreshRSS fetch something from the internet before
 * it answers: `quickadd` downloads and parses the feed, `subscription/import`
 * subscribes to every entry of an OPML file and then refreshes all of them.
 */
export const SLOW_REQUEST_TIMEOUT_MS = 120_000;

/** Path of the Google Reader compatible API below the instance root. */
const API_PREFIX = '/api/greader.php';
const READER_PREFIX = `${API_PREFIX}/reader/api/0`;

export class FreshRssApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    method: string,
    path: string
  ) {
    super(`FreshRSS API ${method} ${path} failed with HTTP ${status}`);
    this.name = 'FreshRssApiError';
  }
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  text: string;
  contentType: string;
}

export interface SendOptions {
  headers?: Record<string, string>;
  /** Sent as `application/x-www-form-urlencoded`. */
  form?: URLSearchParams;
  /** Sent verbatim; requires `contentType`. */
  rawBody?: string;
  contentType?: string;
  timeoutMs?: number;
}

/**
 * Bare HTTP transport for the FreshRSS instance: no authentication, no response
 * parsing. Split out from {@link FreshRssApi} so {@link AuthSession} can perform
 * the login without depending on an authenticated client.
 */
export class HttpClient {
  private readonly baseUrl: string;
  /**
   * Only set when FRESHRSS_INSECURE_TLS is enabled. Scopes the relaxed
   * certificate validation to requests against the configured host instead of
   * disabling it process-wide via NODE_TLS_REJECT_UNAUTHORIZED.
   */
  private readonly insecureDispatcher?: Agent;

  constructor(config: Config) {
    this.baseUrl = config.url ?? '';
    if (config.insecureTls) {
      this.insecureDispatcher = new Agent({
        connect: { rejectUnauthorized: false },
      });
    }
  }

  async send(
    method: string,
    path: string,
    options: SendOptions = {}
  ): Promise<HttpResponse> {
    const headers: Record<string, string> = { ...options.headers };
    const init: RequestInit = {
      method,
      headers,
      // Never follow a redirect: it would resend the Authorization header to
      // whatever host the upstream points at.
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    };
    if (options.form !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = options.form.toString();
    } else if (options.rawBody !== undefined) {
      headers['Content-Type'] = options.contentType ?? 'text/plain';
      init.body = options.rawBody;
    }

    const url = `${this.baseUrl}${path}`;
    // The insecure dispatcher requires undici's own fetch; the default path uses
    // the (stubbable) global fetch so tests can intercept it.
    const response = this.insecureDispatcher
      ? await undiciFetch(url, {
          ...init,
          dispatcher: this.insecureDispatcher,
        } as UndiciRequestInit)
      : await fetch(url, init);

    return {
      status: response.status,
      ok: response.ok,
      text: await response.text(),
      contentType: response.headers.get('content-type') ?? '',
    };
  }
}

/**
 * Client for the Google Reader compatible API of FreshRSS
 * (`/api/greader.php/reader/api/0/…`).
 *
 * Two FreshRSS quirks shape this class:
 *
 * - Write endpoints expect a separate write token (`T`) obtained from `/token`,
 *   which is added automatically by {@link postForm}.
 * - Most write endpoints answer with the plain text `OK`, not with JSON, and
 *   `quickadd` reports failures with HTTP 200 and an `error` field. Callers must
 *   therefore inspect the body, never just the status.
 */
export class FreshRssApi {
  private readonly http: HttpClient;
  private readonly auth: AuthSession;

  constructor(private readonly config: Config) {
    this.http = new HttpClient(config);
    this.auth = new AuthSession(config, this.http);
  }

  /** Throws with setup instructions when credentials are missing. */
  private requireConfig(): void {
    const missing = missingConfigKeys(this.config);
    if (missing.length > 0) {
      throw new Error(missingConfigMessage(missing));
    }
  }

  /**
   * Performs an authenticated request and retries **once** after a 401: the
   * cached login is long-lived and silently becomes invalid when the API
   * password is changed. Exactly one retry, so an actually wrong password
   * cannot turn into a login loop.
   */
  private async authed(
    method: string,
    path: string,
    options: SendOptions = {}
  ): Promise<HttpResponse> {
    this.requireConfig();
    let response = await this.http.send(method, path, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `GoogleLogin auth=${await this.auth.authToken()}`,
      },
    });
    if (response.status === 401) {
      this.auth.invalidate();
      response = await this.http.send(method, path, {
        ...options,
        headers: {
          ...options.headers,
          Authorization: `GoogleLogin auth=${await this.auth.authToken()}`,
        },
      });
    }
    if (!response.ok) {
      throw new FreshRssApiError(response.status, response.text, method, path);
    }
    return response;
  }

  /** GET against the reader API, returning the parsed JSON body. */
  async getJson(
    path: string,
    params: Record<string, string | number | undefined> = {},
    timeoutMs?: number
  ): Promise<unknown> {
    const query = new URLSearchParams({ output: 'json' });
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const response = await this.authed(
      'GET',
      `${READER_PREFIX}${path}?${query.toString()}`,
      timeoutMs === undefined ? {} : { timeoutMs }
    );
    return parseJson(response.text, 'GET', path);
  }

  /** GET against the reader API, returning the raw body (OPML, plain text). */
  async getText(path: string, timeoutMs?: number): Promise<string> {
    const response = await this.authed(
      'GET',
      `${READER_PREFIX}${path}`,
      timeoutMs === undefined ? {} : { timeoutMs }
    );
    return response.text;
  }

  /**
   * POST of a form to the reader API. The write token is attached as `T`; it is
   * required by `edit-tag`, `rename-tag`, `disable-tag` and `mark-all-as-read`
   * and harmless everywhere else.
   */
  async postForm(
    path: string,
    fields: URLSearchParams,
    timeoutMs?: number
  ): Promise<string> {
    this.requireConfig();
    const form = new URLSearchParams(fields);
    form.set('T', await this.auth.writeToken());
    const response = await this.authed(
      'POST',
      `${READER_PREFIX}${path}`,
      timeoutMs === undefined ? { form } : { form, timeoutMs }
    );
    return response.text;
  }

  /** POST of a raw body (used by the OPML import, which reads php://input). */
  async postRaw(
    path: string,
    body: string,
    contentType: string,
    timeoutMs?: number
  ): Promise<string> {
    const response = await this.authed('POST', `${READER_PREFIX}${path}`, {
      rawBody: body,
      contentType,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return response.text;
  }
}

function parseJson(text: string, method: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `FreshRSS API ${method} ${path} returned a body that is not JSON. ` +
        'Check that FRESHRSS_URL points at the root of the FreshRSS instance ' +
        '(the API path /api/greader.php is appended automatically).'
    );
  }
}

/**
 * FreshRSS answers most write endpoints with the plain text `OK`. Anything else
 * is a failure that arrived with a 2xx status, so it has to be detected here.
 */
export function expectOk(body: string, what: string): void {
  if (body.trim() !== 'OK') {
    throw new Error(
      `FreshRSS did not confirm ${what}; it answered: ${truncate(body.trim(), 200)}`
    );
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
