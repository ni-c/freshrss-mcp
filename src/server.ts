import { createRequire } from 'node:module';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { FreshRssApi } from './api.js';
import type { Config } from './config.js';
import { ConfirmationStore } from './confirm.js';
import {
  registerArticleReadTools,
  registerArticleWriteTools,
} from './tools/articles.js';
import {
  registerFeedReadTools,
  registerFeedWriteTools,
} from './tools/feeds.js';
import { registerOpmlReadTools, registerOpmlWriteTools } from './tools/opml.js';
import { registerTagReadTools, registerTagWriteTools } from './tools/tags.js';

function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

export function createServer(config: Config): McpServer {
  const api = new FreshRssApi(config);
  const confirmations = new ConfirmationStore();

  const server = new McpServer({
    name: 'freshrss-mcp',
    version: packageVersion(),
  });

  registerFeedReadTools(server, api);
  registerArticleReadTools(server, api);
  registerTagReadTools(server, api);
  registerOpmlReadTools(server, api);

  // Read-only mode does not register the write tools at all. Rejecting them at
  // call time would still advertise capabilities the server refuses to provide.
  if (!config.readOnly) {
    registerFeedWriteTools(server, api, confirmations);
    registerArticleWriteTools(server, api, confirmations);
    registerTagWriteTools(server, api, confirmations);
    registerOpmlWriteTools(server, api, confirmations);
  }

  return server;
}
