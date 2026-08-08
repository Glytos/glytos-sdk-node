# Changelog

All notable changes to this project are documented in this file. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `dnc` - the numbers your organization must not call: `dnc.list`, `dnc.add`,
  `dnc.import`, `dnc.setScope`, `dnc.remove`. Every outbound call is checked
  against this list, whether it comes from a campaign or from `calls.create`.
- `campaigns.stop`, `campaigns.delete` and `campaigns.addContacts` (upload a
  contact list as CSV text rather than serving it over HTTP).
- `campaigns.previewSuppression` - how many of a contact list each suppression
  policy would reach, including how many of those people asked on a call not to
  be contacted again.
- `campaigns.create` gained `contacts_csv`, `scheduled_at`, `call_window_start`
  /`call_window_end`, `timezone`, `suppression_policy` and
  `override_caller_requests`.
- `CampaignDetail`, `CampaignContact`, `SuppressionPreview`, `ContactSyncResult`,
  `DncEntry` and their status/scope unions are exported.

### Fixed

- `campaigns.create` typed `contacts` as an array of objects, which the API
  rejects with a 422. It is an array of phone numbers.

## [0.2.0] - 2026-08-02

### Added

- `threads` - conversations with a text agent in thread/run vocabulary:
  `threads.create`, `threads.retrieve`, `threads.messages.create/list`,
  `threads.runs.create/stream`.
- Streaming. `threads.runs.stream`, `agents.streamMessage` and `chat.stream` yield
  `token` deltas and a terminal `done` carrying the finished run.
- Per-turn instructions on every text turn (`instructions`), applied below the
  agent's own and never saved to it.
- File uploads: `chat.uploadFile`, `knowledgeBase.uploadDocument`,
  `vectorStores.uploadDocument`, plus `client.requestForm` for any other multipart
  endpoint.
- `folders` - group agents inside an environment, and `agents.moveToFolder` /
  `agents.removeFromFolder` to file one.
- `imports` - bring an agent over from another platform, and `agents.export` for the
  portable, secret-free JSON that imports back.
- `agents` as an alias of `workflows`, matching what the product calls them.

### Changed

- `sendMessage` returns a typed `Run` and accepts either a string or a turn object;
  the old positional `images` argument still works.

## [0.1.0] - 2026-07-19

### Added

- Initial release.
- `Glytos` client with `workflows`, `calls`, `phoneNumbers`, `sessions` and
  `webhooks` resources, plus a generic `request()` for any other endpoint.
- `verifyWebhook()` for webhook signature verification.
- Typed for TypeScript and built on the global `fetch`.
