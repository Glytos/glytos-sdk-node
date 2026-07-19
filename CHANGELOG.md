# Changelog

All notable changes to this project are documented in this file. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-19

### Added

- Initial release.
- `Glytos` client with `workflows`, `calls`, `phoneNumbers`, `sessions` and
  `webhooks` resources, plus a generic `request()` for any other endpoint.
- `verifyWebhook()` for webhook signature verification.
- Typed for TypeScript and built on the global `fetch`.
