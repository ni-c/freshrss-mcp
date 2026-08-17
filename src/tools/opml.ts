import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { SLOW_REQUEST_TIMEOUT_MS, type FreshRssApi } from '../api.js';
import {
  confirmationPrompt,
  setResourceKey,
  type ConfirmationStore,
} from '../confirm.js';
import { errorResult, run, textResult, ToolInputError } from '../result.js';
import { UNTRUSTED_CONTENT_NOTE } from '../shape.js';

/** Characters of OPML returned to the model. */
const MAX_EXPORT_CHARS = 200_000;
/**
 * Characters of OPML accepted for import. FreshRSS reads at most 1 048 576 bytes
 * of the request body (`file_get_contents('php://input', …, 1048576)`) and
 * silently truncates the rest, which would arrive as malformed XML — so the
 * limit lives here, well below that.
 */
const MAX_IMPORT_CHARS = 900_000;

export function registerOpmlReadTools(
  server: McpServer,
  api: FreshRssApi
): void {
  server.registerTool(
    'export_opml',
    {
      title: 'Export OPML',
      description:
        'Exports all subscriptions as an OPML document — the portable backup format for ' +
        'feed readers. For a readable overview of the subscriptions use list_feeds instead.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () => {
        const opml = await api.getText('/subscription/export');
        const truncated = opml.length > MAX_EXPORT_CHARS;
        return textResult(
          `${UNTRUSTED_CONTENT_NOTE}\n\n` +
            (truncated
              ? `${opml.slice(0, MAX_EXPORT_CHARS)}\n\n(truncated at ${MAX_EXPORT_CHARS} characters)`
              : opml)
        );
      })
  );
}

export function registerOpmlWriteTools(
  server: McpServer,
  api: FreshRssApi,
  confirmations: ConfirmationStore
): void {
  server.registerTool(
    'import_opml',
    {
      title: 'Import OPML',
      description:
        'Subscribes to every feed in an OPML document, creating the categories it names, ' +
        'and then refreshes all feeds — which can take minutes on a large file. There is ' +
        'no bulk undo; every feed would have to be removed individually. Two-step: the ' +
        'first call returns a confirmation token, the second call with that token performs ' +
        'the import.',
      inputSchema: {
        opml: z.string().min(1).describe('OPML document'),
        confirm_token: z
          .string()
          .optional()
          .describe('Token from the first call of this tool'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ opml, confirm_token }) =>
      run(async () => {
        if (opml.length > MAX_IMPORT_CHARS) {
          throw new ToolInputError(
            `the OPML document is too large (${opml.length} characters, limit ${MAX_IMPORT_CHARS}). ` +
              'Split it or import it through the FreshRSS web interface.'
          );
        }
        // The token is bound to the exact document: confirming a small OPML must
        // not authorise importing a different, larger one.
        const resource = setResourceKey('import_opml', [opml]);

        if (!confirmations.consume(resource, confirm_token)) {
          if (confirm_token !== undefined) {
            return errorResult(
              'The confirmation token is invalid, expired or was issued for a different ' +
                'document. Call import_opml without a token to get a new one.'
            );
          }
          const outlines = (opml.match(/<outline\b/gi) ?? []).length;
          return textResult(
            confirmationPrompt(
              `import an OPML document with ${outlines} outline element(s), subscribing to ` +
                'every feed it contains and refreshing all feeds afterwards',
              confirmations.issue(resource),
              confirmations.ttlMinutes
            )
          );
        }

        const body = await api.postRaw(
          '/subscription/import',
          opml,
          'application/xml',
          SLOW_REQUEST_TIMEOUT_MS
        );
        if (body.trim() !== 'OK') {
          return errorResult(
            `FreshRSS did not confirm the import; it answered: ${body.trim().slice(0, 200)}`
          );
        }
        return textResult(
          'OPML imported. Call list_feeds to see the resulting subscriptions.'
        );
      })
  );
}
