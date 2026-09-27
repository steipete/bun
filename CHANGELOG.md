# Changelog

## Unreleased

## openclaw-ci-f8ce0690-webkit-562a6f7c

- Qualification build: backport [upstream WebKit `236cd93d6`](https://github.com/oven-sh/WebKit/commit/236cd93d6bdf76eca889bc898a80bc3e0dc64222) to construct microtask call-cache entries in zeroed storage. Thanks to Jarred Sumner and Dylan Conway. OpenClaw UI qualification and attribution to the Usage payload retention failure remain pending.

## openclaw-ci-f8ce0690-webkit-34c56b8c

- Support asynchronous `node:inspector` heap collection after JavaScript becomes idle, with session cancellation and teardown cleanup.
- Keep Linux CI builds independent of distribution-specific ICU shared libraries while preserving ICU 78.3 formatting.
- Retain the JavaScriptCore string-bounds fix while reusing a single inspector heap agent.
- Avoid allocator handoffs during nonblocking event-loop polls.
- Fix crashes when `node:vm` decodes cached function bodies after their temporary bytecode buffers are released. Backport [oven-sh/bun#42229](https://github.com/oven-sh/bun/pull/42229).
