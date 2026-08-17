import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';

// The nav version comes from the root package.json — as a hand-maintained string
// it went stale on the very next release.
const { version } = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../package.json', import.meta.url)),
    'utf8'
  )
) as { version: string };

const site = 'https://freshrss-mcp.ni-c.de';
const description =
  'Read and manage a self-hosted FreshRSS instance from an MCP client';

export default defineConfig({
  title: 'freshrss-mcp',
  description,
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: site },

  head: [
    // NOTE: head entries are NOT rewritten with `base` — keep these paths absolute
    // and correct by hand.
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#4f46e5' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'freshrss-mcp' }],
    ['meta', { property: 'og:title', content: 'freshrss-mcp' }],
    ['meta', { property: 'og:description', content: description }],
    ['meta', { property: 'og:url', content: site }],
    ['meta', { name: 'twitter:card', content: 'summary' }],
  ],

  themeConfig: {
    siteTitle: 'freshrss-mcp',

    nav: [
      { text: 'Guide', link: '/guide/', activeMatch: '/guide/' },
      {
        text: 'Reference',
        link: '/reference/tools',
        activeMatch: '/reference/',
      },
      {
        text: `v${version}`,
        items: [
          { text: 'Changelog', link: '/reference/changelog' },
          {
            text: 'Releases',
            link: 'https://github.com/ni-c/freshrss-mcp/releases',
          },
          {
            text: 'npm package',
            link: 'https://www.npmjs.com/package/@ni-c/freshrss-mcp',
          },
        ],
      },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is freshrss-mcp?', link: '/guide/' },
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Connecting clients', link: '/guide/clients' },
          ],
        },
        {
          text: 'Operating it',
          items: [
            { text: 'Configuration', link: '/guide/configuration' },
            { text: 'Security', link: '/guide/security' },
            { text: 'FAQ & troubleshooting', link: '/guide/faq' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Tools', link: '/reference/tools' },
            { text: 'Environment variables', link: '/reference/environment' },
            { text: 'Changelog', link: '/reference/changelog' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/ni-c/freshrss-mcp' },
    ],

    search: { provider: 'local' },

    editLink: {
      pattern: 'https://github.com/ni-c/freshrss-mcp/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    outline: { level: [2, 3] },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Willi Thiel',
    },
  },

  markdown: {
    // The *-default variants darken comments enough to clear 4.5:1 against the
    // code background; plain github-light lands just under it.
    theme: { light: 'github-light-default', dark: 'github-dark-default' },
  },
});
