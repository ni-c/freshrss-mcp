# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with awk,
     matching "## [x.y.z]". Keep that heading shape exactly. -->

## [Unreleased]

## [0.1.0] - 2026-08-17

### Added

- Initial release: MCP server for FreshRSS, speaking the Google Reader
  compatible API at `/api/greader.php`.
- Read tools: `get_user_info`, `list_feeds`, `list_categories`,
  `get_unread_counts`, `list_articles`, `get_articles`, `list_article_ids`,
  `export_opml`.
- Write tools: `mark_articles`, `mark_all_as_read`, `subscribe_feed`,
  `update_feed`, `unsubscribe_feed`, `rename_category_or_label`,
  `delete_category_or_label`, `import_opml`. Not registered when
  `FRESHRSS_READ_ONLY=true`.
- Confirmation tokens for `mark_all_as_read`, `unsubscribe_feed`,
  `delete_category_or_label` and `import_opml`.
- Plain-text conversion of article HTML with per-article and per-response size
  budgets.
