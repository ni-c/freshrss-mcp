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
 * Ceiling on a response body, in bytes.
 *
 * FreshRSS caps one article at 500 000 characters and `list_articles` asks for
 * at most 100 of them, so a legitimate answer stays well inside 64 MiB even
 * when every article is at the cap and made of four-byte characters is not
 * something a feed does. What the ceiling is for is the other case: an
 * instance, or whatever answers in its place under `FRESHRSS_INSECURE_TLS`,
 * that never stops sending. Everything downstream fits the result to a budget
 * of a few hundred kilobytes; this is the only place where the whole body has
 * to be held at once, and without it that hold had no bound.
 */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
/**
 * Timeout for calls that make FreshRSS fetch something from the internet before
 * it answers: `quickadd` downloads and parses the feed, `subscription/import`
 * subscribes to every entry of an OPML file and then refreshes all of them.
 */
export const SLOW_REQUEST_TIMEOUT_MS = 120_000;

/** Path of the Google Reader compatible API below the instance root. */
const API_PREFIX = '/api/greader.php';
const READER_PREFIX = `${API_PREFIX}/reader/api/0`;

/** Raised when the instance answers with more than {@link MAX_RESPONSE_BYTES}. */
export class ResponseTooLargeError extends Error {
  constructor(method: string, path: string) {
    super(
      `FreshRSS API ${method} ${path} answered with more than ` +
        `${MAX_RESPONSE_BYTES} bytes, which this server refuses to buffer. ` +
        'Narrow the request — use the filters and the count parameter.'
    );
    this.name = 'ResponseTooLargeError';
  }
}

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
      text: await readBounded(response, method, path),
      contentType: response.headers.get('content-type') ?? '',
    };
  }
}

/**
 * What both fetches agree on: undici's `Response` and the global one are the
 * same thing with two incompatible sets of stream types, so this names only
 * the operations the read below performs.
 */
interface BodyLike {
  headers: { get(name: string): string | null };
  body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
      cancel(): Promise<void>;
    };
    cancel(): Promise<void>;
  } | null;
}

/**
 * The body as text, or {@link ResponseTooLargeError} once it passes the
 * ceiling — read in chunks so the refusal costs the ceiling and not the body.
 * A declared length above it is refused before a byte is read.
 */
async function readBounded(
  response: BodyLike,
  method: string,
  path: string
): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ResponseTooLargeError(method, path);
  }
  if (response.body === null) return '';

  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done || value === undefined) break;
    received += value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ResponseTooLargeError(method, path);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(concat(chunks, received));
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
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
   *
   * The options are built per attempt rather than once. The write token `T`
   * rides in the form, and it is derived from the same password hash the auth
   * token is — so after a password change both are stale, `invalidate` drops
   * both, and a retry that re-sent the form it was first given would carry
   * the old `T` under a fresh login and fail the same way again.
   */
  private async authed(
    method: string,
    path: string,
    options: SendOptions | (() => Promise<SendOptions>) = {}
  ): Promise<HttpResponse> {
    this.requireConfig();
    const attempt = async (): Promise<HttpResponse> => {
      const resolved =
        typeof options === 'function' ? await options() : options;
      return this.http.send(method, path, {
        ...resolved,
        headers: {
          ...resolved.headers,
          Authorization: `GoogleLogin auth=${await this.auth.authToken()}`,
        },
      });
    };
    let response = await attempt();
    if (response.status === 401) {
      this.auth.invalidate();
      response = await attempt();
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
    const response = await this.authed(
      'POST',
      `${READER_PREFIX}${path}`,
      async () => {
        const form = new URLSearchParams(fields);
        form.set('T', await this.auth.writeToken());
        return timeoutMs === undefined ? { form } : { form, timeoutMs };
      }
    );
    return response.text;
  }

  /**
   * POST of a form whose response is JSON (`stream/items/contents`).
   *
   * Exists so that endpoint goes through {@link parseJson} like every GET does,
   * instead of a bare `JSON.parse` whose SyntaxError would carry the first
   * characters of an HTML interstitial into the model context and skip the
   * base-URL hint.
   */
  async postFormJson(
    path: string,
    fields: URLSearchParams,
    timeoutMs?: number
  ): Promise<unknown> {
    return parseJson(
      await this.postForm(path, fields, timeoutMs),
      'POST',
      path
    );
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
      `FreshRSS did not confirm ${what}; it answered ${upstreamText(body)}`
    );
  }
}

/**
 * A string the instance wrote, quoted into one of this server's sentences.
 *
 * Bounded and marked, for the same reason article text is: the instance is
 * the operator's, but what it answers with is whatever sits in front of it —
 * a proxy's block page, a hostile deployment, a typo in FRESHRSS_URL that
 * lands on somebody else's server. None of that gets to write an unbounded
 * or unlabelled line into the model's context.
 */
export function upstreamText(text: string, max = 200): string {
  const clean = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  const shown = clean.length > max ? `${clean.slice(0, max)}…` : clean;
  return `(untrusted text from the instance): ${shown}`;
}
