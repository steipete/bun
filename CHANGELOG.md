# Changelog

## Unreleased

- Adapt upstream [#35565](https://github.com/oven-sh/bun/pull/35565): key the lifecycle-script and `--bun` `node` shim directory on the user id (`/tmp/bun-node-<uid>-<sha>`), so a shim directory another user created on the same host no longer drops `node` from lifecycle-script `PATH` (upstream [#42048](https://github.com/oven-sh/bun/issues/42048)).
- Avoid allocator handoffs during nonblocking event-loop polls.
- Fix crashes when `node:vm` decodes cached function bodies after their temporary bytecode buffers are released. Backport [oven-sh/bun#42229](https://github.com/oven-sh/bun/pull/42229).
