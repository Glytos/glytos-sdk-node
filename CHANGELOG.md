# Changelog

All notable changes to this project are documented in this file. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `campaigns.update`, `campaigns.unschedule`, `campaigns.duplicate` and
  `campaigns.export`. A rename is accepted at any point; the schedule and the
  calling window can only be changed before a campaign starts. `unschedule` is
  separate because omitting a field and clearing it are different instructions.
- `Campaign` now carries `counts` and `workflow_name`, and the create response
  carries `imported`. Measure progress against `counts.dialable` rather than
  `counts.total`: suppressed numbers are never dialed.
- `ContactSyncResult` gained `duplicates` and `on_do_not_call`.

- `sipTrunks` - connect a carrier directly over SIP, with no third party in
  between: `presets`, `list`, `create`, `update`, `delete`, `test`. Numbers are
  attached to a registered trunk through `phoneNumbers.importNumber`, which now
  accepts `sip_trunk_uuid`.
- `integrations` and `integrations.connections` - the destinations an agent or an
  automation can act on, and the named connections holding their credentials.
- `automations` - fire an integration action when an event happens:
  `list`, `create`, `update`, `delete`, `runs`, `test`.
- `testSuites` - `list`, `create`, `delete`, `run`.
- `billing` - `credits`, `transactions`, `usage`. Checking the balance before a
  long outbound run no longer needs a raw `request` call.
- `environments.list`, `providers.list`, `providers.resources`, `apiKeys.list`
  /`create`/`delete`, `organizations.retrieve`/`update`/`regions`.
- `knowledgeBase.retrieveDocument` and `knowledgeBase.deleteDocument`. Documents
  could be created and listed but never read back or removed.
- `tools.discoverMcp` - ask an MCP server what it publishes, instead of
  transcribing its schema by hand.
- `imports.connect` and `imports.pull` - list the agents on another platform with
  its API key, then bring over the ones you pick. The key is never stored.
- `workflows.create` accepts `primary_channel`.

### Fixed

- `tools.create` and `tools.update` rejected three kinds the API accepts. The
  union was `http | static | mcp`; it is now the full
  `static | http | mcp | code | integration | client`, so a `code` or
  `integration` tool no longer fails to compile.
- `calls.control` took an untyped object. It now spells out the three actions and
  what each one requires, so a `say` without text is a compile error rather than
  a 422.
- The README listed a `tools.retrieve` that does not exist and named
  `phoneNumbers.import` rather than `importNumber`, and its agent row was missing
  several methods that have shipped for a while.

## [0.3.0] - 2026-08-09

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
