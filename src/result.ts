import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { FreshRssApiError } from './api.js';

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

/** Hard ceiling on a single tool result, as a backstop behind the per-tool caps. */
const MAX_RESULT_BYTES = 400_000;

/**
 * Serializes a result, stripping article content if the payload is still
 * pathologically large after the per-tool truncation.
 *
 * FreshRSS caps a single article at 500 000 characters (`API_MAX_COMPAT_CONTENT_LENGTH`),
 * so one greedy listing can be megabytes of HTML. Everything downstream of this
 * function assumes the budget held; this is what guarantees it.
 */
export function jsonResult(data: unknown): CallToolResult {
  const text = JSON.stringify(data, null, 2);
  if (text.length <= MAX_RESULT_BYTES) return textResult(text);

  const stripped = JSON.stringify(
    data,
    (key, value: unknown) =>
      (key === 'content' || key === 'excerpt') && typeof value === 'string'
        ? '(omitted: result too large)'
        : value,
    2
  );
  const note = `\n\nNote: the result exceeded ${MAX_RESULT_BYTES} characters, so article content was dropped. Fetch it for individual articles with get_articles.`;
  if (stripped.length <= MAX_RESULT_BYTES) return textResult(stripped + note);

  // Dropping `content`/`excerpt` is not always enough: the bulk can sit in fields
  // this replacer does not touch — a listing of tens of thousands of feeds is all
  // titles and URLs. Without this the "hard ceiling" would not be one, so the
  // payload is cut off even though that leaves the JSON unparseable. Truncated
  // JSON the model can see is still better than megabytes of context.
  return textResult(
    `${stripped.slice(0, MAX_RESULT_BYTES)}\n\n… (truncated: the result exceeded ` +
      `${MAX_RESULT_BYTES} characters even without article content, so the JSON above ` +
      'is incomplete. Narrow the request — use the filters and the count parameter.)'
  );
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const MAX_ERROR_BODY_LENGTH = 2000;

/**
 * Limits what an upstream error body can inject into the model context: HTML
 * error pages (reverse proxies, WAFs) are dropped entirely, other bodies are
 * truncated.
 */
function sanitizeErrorBody(body: string): string {
  const trimmed = body.trim();
  if (/^(<!doctype\s|<html[\s>])/i.test(trimmed)) {
    return '(HTML error page omitted)';
  }
  if (trimmed.length > MAX_ERROR_BODY_LENGTH) {
    return `${trimmed.slice(0, MAX_ERROR_BODY_LENGTH)}… (truncated)`;
  }
  return trimmed;
}

function hintFor(status: number): string {
  switch (status) {
    case 400:
      return (
        '\nHint: FreshRSS answers "Bad Request" for a malformed stream id or an ' +
        'unsupported parameter value. Note that a category, label or feed id that ' +
        'merely does not exist does NOT produce this error — verified against 1.29.1, ' +
        'it returns an empty list instead — so this is a request shape problem, not a ' +
        'misspelled name.'
      );
    case 401:
      return (
        '\nHint: check FRESHRSS_USER and FRESHRSS_API_PASSWORD. The password is the ' +
        'API password from the FreshRSS profile page (Settings → Profile → API ' +
        'management), not the web login password.'
      );
    case 404:
      return (
        '\nHint: the API endpoint was not found. FRESHRSS_URL must be the root of the ' +
        'FreshRSS instance (e.g. https://rss.example.com); the path /api/greader.php ' +
        'is appended automatically.'
      );
    case 501:
      return '\nHint: FreshRSS does not implement this variant of the endpoint.';
    case 503:
      return (
        '\nHint: the API is disabled on this instance. Enable it in Settings → ' +
        'Authentication → "Allow API access".'
      );
    default:
      return '';
  }
}

/** Thrown by tools for problems detected before any request goes out. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

/**
 * Runs a tool handler and converts thrown errors into MCP error results instead
 * of protocol-level failures.
 */
export async function run(
  fn: () => Promise<CallToolResult>
): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ToolInputError) {
      return errorResult(error.message);
    }
    if (error instanceof FreshRssApiError) {
      return errorResult(
        `${error.message}\n${sanitizeErrorBody(error.body)}${hintFor(error.status)}`
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`freshrss-mcp: ${message}`);
  }
}
