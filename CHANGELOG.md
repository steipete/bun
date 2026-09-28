# Changelog

## Unreleased

- Use a private fallback for unusable POSIX `node` shim directories instead of silently dropping `node`, warn when no shim can be created, and honor `BUN_TMPDIR` for the shim like the node-gyp directory.
- Adapt upstream [#35565](https://github.com/oven-sh/bun/pull/35565): key the lifecycle-script and `--bun` `node` shim directory on the user id (`/tmp/bun-node-<uid>-<sha>`), so a shim directory another user created on the same host no longer drops `node` from lifecycle-script `PATH` (upstream [#42048](https://github.com/oven-sh/bun/issues/42048)).

## openclaw-ci-9a6bbd45-webkit-440fe0f8

- Resolve explicit tsconfig overrides from their containing directory and remove the obsolete zero-descriptor fallback.
- Preserve the subscribers present at the start of a `diagnostics_channel` publication when callbacks subscribe or unsubscribe.
- Correct `Intl.Segments.containing()` boundaries around UTF-16 surrogate pairs while preserving `isWordLike`.

## openclaw-ci-f8ce0690-webkit-562a6f7c

- Qualification build: backport [upstream WebKit `236cd93d6`](https://github.com/oven-sh/WebKit/commit/236cd93d6bdf76eca889bc898a80bc3e0dc64222) to construct microtask call-cache entries in zeroed storage. Thanks to Jarred Sumner and Dylan Conway. OpenClaw UI qualification and attribution to the Usage payload retention failure remain pending.

## openclaw-ci-f8ce0690-webkit-34c56b8c

- Support asynchronous `node:inspector` heap collection after JavaScript becomes idle, with session cancellation and teardown cleanup.
- Keep Linux CI builds independent of distribution-specific ICU shared libraries while preserving ICU 78.3 formatting.
- Retain the JavaScriptCore string-bounds fix while reusing a single inspector heap agent.
- Avoid allocator handoffs during nonblocking event-loop polls.
- Fix crashes when `node:vm` decodes cached function bodies after their temporary bytecode buffers are released. Backport [oven-sh/bun#42229](https://github.com/oven-sh/bun/pull/42229).
