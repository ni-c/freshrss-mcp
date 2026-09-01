import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { setResourceKey } from 'mcp-approval';
import type { Approver, ConfirmationStore } from 'mcp-approval';
import {
  labelFromStreamId,
  unreadCountIndex,
  UNTRUSTED_CONTENT_NOTE,
  type RawTag,
} from '../shape.js';

import { expectOk, type FreshRssApi } from '../api.js';
import { READ_ONLY } from './annotations.js';
import { errorResult, jsonResult, run, textResult } from '../result.js';
import { assertTagName, SPECIAL_STREAMS } from '../streams.js';

// The unread-count endpoint is shared with the feed tools, which own it.
import {
  loadUnreadCountsOptional,
  UNREAD_COUNTS_UNAVAILABLE,
} from './feeds.js';

export function registerTagReadTools(
  server: McpServer,
  api: FreshRssApi
): void {
  server.registerTool(
    'list_categories',
    {
      title: 'List categories and labels',
      description:
        'Lists the categories (folders that hold feeds) and the user labels (tags that ' +
        'are attached to individual articles), each with its unread count. Both are ' +
        'addressed by name in the other tools.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () =>
      run(async () => {
        const [tagList, counts] = await Promise.all([
          api.getJson('/tag/list') as Promise<{ tags?: RawTag[] }>,
          loadUnreadCountsOptional(api),
        ]);
        const unread = unreadCountIndex(counts?.unreadcounts ?? []);

        const categories: { name: string; unreadCount: number | undefined }[] =
          [];
        const labels: { name: string; unreadCount: number | undefined }[] = [];
        for (const tag of tagList.tags ?? []) {
          const name = labelFromStreamId(tag.id);
          if (name === null) continue;
          const entry = {
            name,
            unreadCount: tag.unread_count ?? unread.get(tag.id ?? ''),
          };
          if (tag.type === 'tag') labels.push(entry);
          else categories.push(entry);
        }

        return jsonResult({
          categories,
          labels,
          specialStreams: Object.keys(SPECIAL_STREAMS),
          notes:
            counts === undefined
              ? [UNTRUSTED_CONTENT_NOTE, UNREAD_COUNTS_UNAVAILABLE]
              : [UNTRUSTED_CONTENT_NOTE],
        });
      })
  );
}

export function registerTagWriteTools(
  server: McpServer,
  api: FreshRssApi,
  confirmations: ConfirmationStore,
  approval: Approver
): void {
  server.registerTool(
    'rename_category_or_label',
    {
      title: 'Rename a category or label',
      description:
        'Renames a category (folder) or a user label. FreshRSS resolves the name against ' +
        'its categories first and falls back to labels, so one tool covers both. Feeds and ' +
        'articles keep their assignment.',
      inputSchema: z.object({
        name: z
          .string()
          .describe('Current name, exactly as in list_categories'),
        new_name: z.string().describe('New name'),
      }),
      annotations: {
        // Replaces a name somebody chose, on every feed or article carrying
        // it. Had no annotations at all, so it inherited the destructive
        // default — which happens to be right, but was never a decision.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ name, new_name }) =>
      run(async () => {
        const from = assertTagName(name, 'category or label');
        const to = assertTagName(new_name, 'new category or label');
        if (from === to) {
          return errorResult('The new name is identical to the current one.');
        }
        const form = new URLSearchParams({
          s: `user/-/label/${from}`,
          dest: `user/-/label/${to}`,
        });
        expectOk(await api.postForm('/rename-tag', form), 'the rename');
        return textResult('Renamed.');
      })
  );

  server.registerTool(
    'delete_category_or_label',
    {
      title: 'Delete a category or label',
      description:
        'Deletes a category (its feeds move to the default category, no articles are lost) ' +
        'or a user label (it is detached from every article). FreshRSS matches categories ' +
        'first, so a category and a label of the same name cannot be told apart here. ' +
        'Two-step: the first call returns a confirmation token, the second call with that ' +
        'token performs the deletion.',
      inputSchema: z.object({
        name: z.string().describe('Name, exactly as in list_categories'),
        confirm_token: z
          .string()
          .optional()
          .describe('Token from the first call of this tool'),
      }),
      annotations: {
        // A category moves its feeds to the default; a label is removed from
        // every article. Neither comes back.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ name, confirm_token }, mcp) =>
      run(async () => {
        const target = assertTagName(name, 'category or label');
        const resource = setResourceKey('delete_category_or_label', [target]);

        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: 'delete the given category or label',
            consequence:
              'If it is a category its feeds move to the default category; if it ' +
              'is a label it is removed from every article. Neither can be undone ' +
              'from here.',
            resourceKey: resource,
            token: confirm_token,
            toolName: 'delete_category_or_label',
            hint: 'Tick to go ahead, leave it to cancel.',
          }
        );
        // A token that was sent and did not match is refused with the reason
        // rather than answered with a fresh prompt; the sentence is the
        // library's, so every server refuses in the same words.
        if (outcome.decision === 'rejected') {
          return errorResult(outcome.reason);
        }
        if (outcome.decision === 'declined') {
          return errorResult(
            `The user declined. delete_category_or_label did nothing.`
          );
        }
        if (outcome.decision === 'pending') return outcome.result;

        const form = new URLSearchParams({ s: `user/-/label/${target}` });
        expectOk(await api.postForm('/disable-tag', form), 'the deletion');
        return textResult('Deleted.');
      })
  );
}
