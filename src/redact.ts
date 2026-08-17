/**
 * Matches the userinfo part of a URL (`scheme://user:pass@`).
 *
 * Applied as a string rewrite rather than via `new URL`, for two reasons: a value
 * that is already percent- or XML-encoded is handed back byte-identical when it
 * holds no credentials, and a value that is *not* a valid URL — the case
 * `loadConfig` reports on — still gets redacted.
 */
const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i;

/**
 * Removes credentials from a URL before it reaches the model or a log.
 *
 * FreshRSS stores HTTP-auth feeds as `https://user:pass@host/feed` and returns
 * that verbatim from `subscription/list` and in the OPML export. Without this a
 * plain `list_feeds` would print the password of a paid or private feed into the
 * model context and the conversation transcript.
 */
export function redactUrlCredentials(url: string): string {
  return url.replace(URL_USERINFO, '$1***@');
}

/** Same redaction for the `xmlUrl`/`htmlUrl` attributes of an OPML document. */
export function redactOpmlCredentials(opml: string): string {
  return opml.replace(
    /\b(xmlUrl|htmlUrl)="([^"]*)"/gi,
    (match, attribute: string, value: string) =>
      URL_USERINFO.test(value)
        ? `${attribute}="${value.replace(URL_USERINFO, '$1***@')}"`
        : match
  );
}
