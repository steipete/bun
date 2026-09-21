# Changelog

This changelog records changes maintained in this fork.

## Unreleased

### Fixed

- HTTP server sockets apply receive backpressure to raw `CONNECT` and upgrade streams.
- HTTP server sockets preserve ordinary `pause()` behavior while receive backpressure follows readable capacity.
- Headers initialization honors custom iterators, and `server.fetch()` copies headers. Thanks @robobun ([#43023](https://github.com/oven-sh/bun/pull/43023)) and @Jarred-Sumner ([#40888](https://github.com/oven-sh/bun/pull/40888)).
- HTTP server socket `bytesWritten` includes raw socket writes after an upgrade.
- `FileSink.flush()` reports completed bytes for small pipe writes. FileSink-backed `fs.WriteStream` callbacks wait for write completion and use Writable's queue, cork, drain, and error handling.
