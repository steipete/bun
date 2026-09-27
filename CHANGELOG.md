# Changelog

## Unreleased

## openclaw-ci-f8ce0690-webkit-34c56b8c

- Support asynchronous `node:inspector` heap collection after JavaScript becomes idle, with session cancellation and teardown cleanup.
- Keep Linux CI builds independent of distribution-specific ICU shared libraries while preserving ICU 78.3 formatting.
- Retain the JavaScriptCore string-bounds fix while reusing a single inspector heap agent.
- Avoid allocator handoffs during nonblocking event-loop polls.
- Fix crashes when `node:vm` decodes cached function bodies after their temporary bytecode buffers are released. Backport [oven-sh/bun#42229](https://github.com/oven-sh/bun/pull/42229).
