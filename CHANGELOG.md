# Changelog

## Unreleased

- Avoid allocator handoffs during nonblocking event-loop polls.
- Fix crashes when `node:vm` decodes cached function bodies after their temporary bytecode buffers are released. Backport [oven-sh/bun#42229](https://github.com/oven-sh/bun/pull/42229).
