import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, bunRun, isLinux, isWindows, nodeExe, tempDir, tls as tlsCert } from "harness";
import http from "http";

import { once } from "node:events";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { join } from "node:path";
import tls from "node:tls";
function connectClient(proxyAddress: AddressInfo, targetAddress: AddressInfo, add_http_prefix: boolean) {
  const client = net.connect({ port: proxyAddress.port, host: proxyAddress.address }, () => {
    client.write(
      `CONNECT ${add_http_prefix ? "http://" : ""}${targetAddress.address}:${targetAddress.port} HTTP/1.1\r\nHost: ${targetAddress.address}:${targetAddress.port}\r\nProxy-Authorization: Basic dXNlcjpwYXNzd29yZA==\r\n\r\n`,
    );
  });

  const received: string[] = [];
  const { promise, resolve, reject } = Promise.withResolvers<string>();

  client.on("data", data => {
    if (data.toString().includes("200 Connection established")) {
      client.write("GET / HTTP/1.1\r\nHost: www.example.com:80\r\nConnection: close\r\n\r\n");
    }
    received.push(data.toString());
  });
  client.on("error", reject);

  client.on("end", () => {
    resolve(received.join(""));
  });
  return promise;
}

const BIG_DATA = Buffer.alloc(1024 * 1024 * 64, "bun").toString();
describe("HTTP server CONNECT", () => {
  test("should handle backpressure", async () => {
    const responseHeader = "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n";
    await using proxyServer = http.createServer((req, res) => {
      res.end("Hello World from proxy server");
    });
    await using targetServer = net.createServer(socket => {
      // Accepted net sockets start in Node's flowing=null state; drain the
      // inbound GET so 'end' can fire and server.close() can resolve.
      socket.resume();
      socket.write(responseHeader, () => {
        socket.write(BIG_DATA, () => {
          //TODO: is this a net bug? on windows the connection is closed before everything is sended
          Bun.sleep(100).then(() => {
            socket.end();
          });
        });
      });
    });
    let proxyHeaders = {};
    proxyServer.on("connect", (req, socket, head) => {
      proxyHeaders = req.headers;
      const [host, port] = req.url?.split(":") ?? [];

      const serverSocket = net.connect(parseInt(port), host, async () => {
        socket.write(`HTTP/1.1 200 Connection established\r\nConnection: close\r\n\r\n`);
        serverSocket.pipe(socket);
        socket.pipe(serverSocket);
      });
      serverSocket.on("error", err => {
        socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      });
      socket.on("error", err => {
        serverSocket.destroy();
      });

      socket.on("end", () => serverSocket.end());
      serverSocket.on("end", () => socket.end());
    });
    await once(proxyServer.listen(0, "127.0.0.1"), "listening");
    const proxyAddress = proxyServer.address() as AddressInfo;

    await once(targetServer.listen(0, "127.0.0.1"), "listening");
    const targetAddress = targetServer.address() as AddressInfo;

    {
      const response = await connectClient(proxyAddress, targetAddress, false);
      expect(proxyHeaders["proxy-authorization"]).toBe("Basic dXNlcjpwYXNzd29yZA==");
      expect(response).toContain("HTTP/1.1 200 OK");
      expect(response.length).toBeGreaterThan(responseHeader.length + BIG_DATA.length);
      expect(response).toContain(BIG_DATA);
    }
  });

  test("should handle data, drain, end and close events", async () => {
    await using proxyServer = http.createServer((req, res) => {
      res.end("Hello World from proxy server");
    });

    await once(proxyServer.listen(0, "127.0.0.1"), "listening");
    const proxyAddress = proxyServer.address() as AddressInfo;
    let data_received: string[] = [];
    let client_data_received: string[] = [];
    let proxy_drain_received = false;
    let proxy_end_received = false;

    const { promise, resolve, reject } = Promise.withResolvers<string>();

    const { promise: clientPromise, resolve: clientResolve, reject: clientReject } = Promise.withResolvers<string>();
    const clientSocket = net.connect(proxyAddress.port, proxyAddress.address, () => {
      clientSocket.on("error", clientReject);
      clientSocket.on("data", chunk => {
        client_data_received.push(chunk?.toString());
      });
      clientSocket.on("end", () => {
        clientSocket.end();
        clientResolve(client_data_received.join(""));
      });

      clientSocket.write("CONNECT localhost:80 HTTP/1.1\r\nHost: localhost:80\r\nConnection: close\r\n\r\n");
    });

    proxyServer.on("connect", (req, socket, head) => {
      expect(head).toBeInstanceOf(Buffer);
      socket.on("data", chunk => {
        data_received.push(chunk?.toString());
      });
      socket.on("end", () => {
        proxy_end_received = true;
      });
      socket.on("close", () => {
        resolve(data_received.join(""));
      });
      socket.on("drain", () => {
        proxy_drain_received = true;
        socket.end();
      });
      socket.on("error", reject);
      proxy_drain_received = false;
      // write until backpressure
      while (socket.write(BIG_DATA)) {}
      clientSocket.write("Hello World");
    });

    expect(await promise).toContain("Hello World");
    expect(await clientPromise).toContain(BIG_DATA);
    expect(proxy_drain_received).toBe(true);
    expect(proxy_end_received).toBe(true);
  });

  test("should handle CONNECT with invalid target", async () => {
    await using proxyServer = http.createServer((req, res) => {
      res.end("Hello World from proxy server");
    });

    proxyServer.on("connect", (req, socket, head) => {
      const [host, port] = req.url?.split(":") ?? [];

      const serverSocket = net.connect(parseInt(port) || 80, host, () => {
        socket.write(`HTTP/1.1 200 Connection established\r\n\r\n`);
        serverSocket.pipe(socket);
        socket.pipe(serverSocket);
      });

      serverSocket.on("error", err => {
        socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        socket.end();
      });

      socket.on("error", () => serverSocket.destroy());
    });

    await once(proxyServer.listen(0, "127.0.0.1"), "listening");
    const proxyAddress = proxyServer.address() as AddressInfo;

    const client = net.connect(proxyAddress.port, proxyAddress.address, () => {
      client.write("CONNECT invalid.host.that.does.not.exist:9999 HTTP/1.1\r\nHost: invalid.host:9999\r\n\r\n");
    });

    const { promise, resolve } = Promise.withResolvers<string>();
    const received: string[] = [];

    client.on("data", data => {
      received.push(data.toString());
    });

    client.on("end", () => {
      resolve(received.join(""));
    });

    const response = await promise;
    expect(response).toContain("502 Bad Gateway");
  });

  // TODO: timeout is not supported in bun socket yet
  test.todo("should handle socket timeout", async () => {
    await using proxyServer = http.createServer();
    let timeoutFired = false;

    proxyServer.on("connect", (req, socket, head) => {
      socket.setTimeout(100);
      socket.on("timeout", () => {
        timeoutFired = true;
        socket.write("HTTP/1.1 408 Request Timeout\r\n\r\n");
        socket.end();
      });

      // Don't send any response immediately
    });

    await once(proxyServer.listen(0, "127.0.0.1"), "listening");
    const proxyAddress = proxyServer.address() as AddressInfo;

    const client = net.connect(proxyAddress.port, proxyAddress.address, () => {
      client.write("CONNECT example.com:80 HTTP/1.1\r\nHost: example.com\r\n\r\n");
    });

    const { promise, resolve } = Promise.withResolvers<string>();
    const received: string[] = [];

    client.on("data", data => {
      received.push(data.toString());
    });

    client.on("end", () => {
      resolve(received.join(""));
    });

    const response = await promise;
    expect(timeoutFired).toBe(true);
    expect(response).toContain("408 Request Timeout");
  });

  //TODO pause and resume only not supported in bun socket yet
  test.todo("should handle socket pause and resume", async () => {
    await using proxyServer = http.createServer();
    let pauseCount = 0;
    let resumeCount = 0;

    proxyServer.on("connect", (req, socket, head) => {
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");

      // Simulate backpressure scenario
      const interval = setInterval(() => {
        const canWrite = socket.write("X".repeat(1024));
        if (!canWrite) {
          pauseCount++;
          socket.pause();
          setTimeout(() => {
            resumeCount++;
            socket.resume();
          }, 50);
        }
      }, 10);

      socket.on("end", () => {
        clearInterval(interval);
        socket.end();
      });
    });

    await once(proxyServer.listen(0, "127.0.0.1"), "listening");
    const proxyAddress = proxyServer.address() as AddressInfo;

    const client = net.connect(proxyAddress.port, proxyAddress.address, () => {
      client.write("CONNECT example.com:80 HTTP/1.1\r\nHost: example.com\r\n\r\n");

      setTimeout(() => client.end(), 200);
    });

    const { promise, resolve } = Promise.withResolvers<number>();
    let bytesReceived = 0;

    client.on("data", data => {
      bytesReceived += data.length;
    });

    client.on("end", () => {
      resolve(bytesReceived);
    });

    const totalBytes = await promise;
    expect(totalBytes).toBeGreaterThan(0);
    expect(pauseCount).toBeGreaterThan(0);
    expect(resumeCount).toBeGreaterThan(0);
  });

  test("should deliver bytes following a CONNECT request with Content-Length: 0 to the connect socket, not as a new request", async () => {
    const requestUrls: string[] = [];
    await using proxyServer = http.createServer((req, res) => {
      requestUrls.push(req.url ?? "");
      res.end();
    });

    const pipelined = "GET /pipelined HTTP/1.1\r\nHost: example.com\r\n\r\n";
    const afterEstablished = "GET /after-established HTTP/1.1\r\nHost: example.com\r\n\r\n";
    const expectedTunneled = pipelined + afterEstablished;

    const { promise: tunneled, resolve: resolveTunneled, reject: rejectTunneled } = Promise.withResolvers<string>();
    proxyServer.on("connect", (req, socket, head) => {
      const chunks: Buffer[] = [head];
      let receivedLength = head.length;
      socket.on("data", chunk => {
        chunks.push(chunk);
        receivedLength += chunk.length;
        if (receivedLength >= Buffer.byteLength(expectedTunneled)) {
          socket.end();
        }
      });
      socket.on("end", () => {
        resolveTunneled(Buffer.concat(chunks).toString());
      });
      socket.on("error", rejectTunneled);
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    });

    await once(proxyServer.listen(0, "127.0.0.1"), "listening");
    const proxyAddress = proxyServer.address() as AddressInfo;

    const { promise: clientReceived, resolve: resolveClient, reject: rejectClient } = Promise.withResolvers<string>();
    const received: string[] = [];
    const client = net.connect(proxyAddress.port, proxyAddress.address, () => {
      client.write(`CONNECT example.com:80 HTTP/1.1\r\nHost: example.com:80\r\nContent-Length: 0\r\n\r\n${pipelined}`);
    });
    client.on("data", data => {
      received.push(data.toString());
      if (received.join("") === "HTTP/1.1 200 Connection established\r\n\r\n") {
        client.write(afterEstablished);
      }
    });
    client.on("error", rejectClient);
    client.on("end", () => {
      client.end();
      resolveClient(received.join(""));
    });

    expect(await tunneled).toBe(expectedTunneled);
    expect(await clientReceived).toBe("HTTP/1.1 200 Connection established\r\n\r\n");
    expect(requestUrls).toEqual([]);
  });

  // Node v26.3.0 tunnels "5\r\nhello\r\n0\r\n\r\nGET ..." verbatim — the chunked framing
  // bytes reach the connect socket un-decoded and no 'request' event fires.
  test("should deliver bytes following a CONNECT request with Transfer-Encoding: chunked raw, not chunk-decoded", async () => {
    const requestUrls: string[] = [];
    await using proxyServer = http.createServer((req, res) => {
      requestUrls.push(req.url ?? "");
      res.end();
    });

    const pipelined = "5\r\nhello\r\n0\r\n\r\nGET /smuggled HTTP/1.1\r\nHost: example.com\r\n\r\n";
    const afterEstablished = "GET /after-established HTTP/1.1\r\nHost: example.com\r\n\r\n";
    const expectedTunneled = pipelined + afterEstablished;

    const { promise: tunneled, resolve: resolveTunneled, reject: rejectTunneled } = Promise.withResolvers<string>();
    proxyServer.on("connect", (req, socket, head) => {
      const chunks: Buffer[] = [head];
      let receivedLength = head.length;
      socket.on("data", chunk => {
        chunks.push(chunk);
        receivedLength += chunk.length;
        if (receivedLength >= Buffer.byteLength(expectedTunneled)) {
          socket.end();
        }
      });
      socket.on("end", () => {
        resolveTunneled(Buffer.concat(chunks).toString());
      });
      socket.on("error", rejectTunneled);
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    });

    await once(proxyServer.listen(0, "127.0.0.1"), "listening");
    const proxyAddress = proxyServer.address() as AddressInfo;

    const { promise: clientReceived, resolve: resolveClient, reject: rejectClient } = Promise.withResolvers<string>();
    const received: string[] = [];
    const client = net.connect(proxyAddress.port, proxyAddress.address, () => {
      client.write(
        `CONNECT example.com:80 HTTP/1.1\r\nHost: example.com:80\r\nTransfer-Encoding: chunked\r\n\r\n${pipelined}`,
      );
    });
    client.on("data", data => {
      received.push(data.toString());
      if (received.join("") === "HTTP/1.1 200 Connection established\r\n\r\n") {
        client.write(afterEstablished);
      }
    });
    client.on("error", rejectClient);
    client.on("end", () => {
      client.end();
      resolveClient(received.join(""));
    });

    expect(await tunneled).toBe(expectedTunneled);
    expect(await clientReceived).toBe("HTTP/1.1 200 Connection established\r\n\r\n");
    expect(requestUrls).toEqual([]);
  });

  // Node v26.3.0 tunnels "helloGET /smuggled ..." verbatim — the declared body and
  // everything after it reach the connect socket and no 'request' event fires.
  test("should deliver the body and trailing bytes of a CONNECT request with a nonzero Content-Length to the connect socket, not as a new request", async () => {
    const requestUrls: string[] = [];
    await using proxyServer = http.createServer((req, res) => {
      requestUrls.push(req.url ?? "");
      res.end();
    });

    const pipelined = "helloGET /smuggled HTTP/1.1\r\nHost: example.com\r\n\r\n";
    const afterEstablished = "GET /after-established HTTP/1.1\r\nHost: example.com\r\n\r\n";
    const expectedTunneled = pipelined + afterEstablished;

    const { promise: tunneled, resolve: resolveTunneled, reject: rejectTunneled } = Promise.withResolvers<string>();
    proxyServer.on("connect", (req, socket, head) => {
      const chunks: Buffer[] = [head];
      let receivedLength = head.length;
      socket.on("data", chunk => {
        chunks.push(chunk);
        receivedLength += chunk.length;
        if (receivedLength >= Buffer.byteLength(expectedTunneled)) {
          socket.end();
        }
      });
      socket.on("end", () => {
        resolveTunneled(Buffer.concat(chunks).toString());
      });
      socket.on("error", rejectTunneled);
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    });

    await once(proxyServer.listen(0, "127.0.0.1"), "listening");
    const proxyAddress = proxyServer.address() as AddressInfo;

    const { promise: clientReceived, resolve: resolveClient, reject: rejectClient } = Promise.withResolvers<string>();
    const received: string[] = [];
    const client = net.connect(proxyAddress.port, proxyAddress.address, () => {
      client.write(`CONNECT example.com:80 HTTP/1.1\r\nHost: example.com:80\r\nContent-Length: 5\r\n\r\n${pipelined}`);
    });
    client.on("data", data => {
      received.push(data.toString());
      if (received.join("") === "HTTP/1.1 200 Connection established\r\n\r\n") {
        client.write(afterEstablished);
      }
    });
    client.on("error", rejectClient);
    client.on("end", () => {
      client.end();
      resolveClient(received.join(""));
    });

    expect(await tunneled).toBe(expectedTunneled);
    expect(await clientReceived).toBe("HTTP/1.1 200 Connection established\r\n\r\n");
    expect(requestUrls).toEqual([]);
  });

  // Node v26.3.0: HPE_INVALID_CONTENT_LENGTH — Transfer-Encoding + Content-Length is
  // rejected with a 400 before the 'connect' event is dispatched.
  test("should reject a CONNECT request carrying both Transfer-Encoding and Content-Length with a 400", async () => {
    const requestUrls: string[] = [];
    await using proxyServer = http.createServer((req, res) => {
      requestUrls.push(req.url ?? "");
      res.end();
    });
    let connectEvents = 0;
    proxyServer.on("connect", (req, socket) => {
      connectEvents++;
      socket.end();
    });

    await once(proxyServer.listen(0, "127.0.0.1"), "listening");
    const proxyAddress = proxyServer.address() as AddressInfo;

    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const received: string[] = [];
    const client = net.connect(proxyAddress.port, proxyAddress.address, () => {
      client.write(
        "CONNECT example.com:80 HTTP/1.1\r\nHost: example.com:80\r\nTransfer-Encoding: chunked\r\nContent-Length: 5\r\n\r\n",
      );
    });
    client.on("data", data => received.push(data.toString()));
    client.on("error", reject);
    client.on("close", () => resolve(received.join("")));

    const response = await promise;
    expect(response).toContain("400 Bad Request");
    expect(connectEvents).toBe(0);
    expect(requestUrls).toEqual([]);
  });

  test("should handle malformed CONNECT requests", async () => {
    await using proxyServer = http.createServer();

    proxyServer.on("connect", (req, socket, head) => {
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      socket.end();
    });

    await once(proxyServer.listen(0, "127.0.0.1"), "listening");
    const proxyAddress = proxyServer.address() as AddressInfo;

    // Requests Node.js rejects before dispatching the 'connect' event.
    const malformedRequests = [
      "CONNECT\r\n\r\n", // Missing target
      "CONNEC example.com:80 HTTP/1.1\r\n\r\n", // Typo in method
      "CONNECT example.com:80\r\n\r\n", // Missing HTTP version (Node.js treats this as ancient HTTP; we reject it)
    ];

    // Node.js dispatches these to the 'connect' event: CONNECT requests are
    // exempt from the Host requirement and the authority form is not
    // validated beyond tokenization (verified against Node.js).
    const acceptedRequests = [
      "CONNECT example.com HTTP/1.1\r\n\r\n", // Missing port
      "CONNECT :80 HTTP/1.1\r\n\r\n", // Missing host
    ];

    for (const request of acceptedRequests) {
      const client = net.connect(proxyAddress.port, proxyAddress.address, () => {
        client.write(request);
      });

      const { promise, resolve } = Promise.withResolvers<string>();
      const received: string[] = [];
      client.on("data", data => {
        received.push(data.toString());
      });
      client.on("end", () => {
        resolve(received.join(""));
      });
      client.on("error", () => {
        resolve("CONNECTION_ERROR");
      });

      const response = await promise;
      expect(response).toContain("200 Connection established");
    }

    for (const request of malformedRequests) {
      const client = net.connect(proxyAddress.port, proxyAddress.address, () => {
        client.write(request);
      });

      const { promise, resolve } = Promise.withResolvers<string>();
      const received: string[] = [];

      client.on("data", data => {
        received.push(data.toString());
      });

      client.on("end", () => {
        resolve(received.join(""));
      });

      client.on("error", () => {
        resolve("CONNECTION_ERROR");
      });

      setTimeout(() => {
        client.end();
        resolve(received.join("") || "TIMEOUT");
      }, 100);

      const response = await promise;
      // Should either get an error response or timeout/connection error
      expect(response).not.toContain("200 Connection established");
    }
  });

  // https CONNECT: server socket.end() after peer FIN must also FIN the TCP
  // write side. Linux-only: the close is observed via EPOLLHUP once both halves
  // have FIN'd; kqueue/libuv need the readable_ended re-arm to re-derive it.
  test.skipIf(!isLinux)(
    "https CONNECT socket.end() after peer FIN half-closes TCP so the socket can close",
    async () => {
      // tls.connect wraps a raw net.Socket so end() sends a raw FIN (not
      // close_notify first): that ordering has the server's eof already
      // consumed by allow_half_open before the deferred socket.end() runs.
      const fixture = /* js */ `
      const https = require("node:https");
      const net = require("node:net");
      const tls = require("node:tls");

      const server = https.createServer({ cert: process.env.CERT, key: process.env.KEY }, () => {});
      server.on("connect", (req, socket) => {
        // autoDestroy off: only the transport (EPOLLHUP once our FIN answers
        // the peer's) can close this socket.
        socket._readableState.autoDestroy = false;
        socket._writableState.autoDestroy = false;
        socket.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n");
        socket.on("end", () => {
          console.log("server:end");
          socket.end();
        });
        socket.on("finish", () => console.log("server:finish"));
        socket.on("close", () => {
          console.log("server:close");
          server.close();
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const raw = net.connect({ port: server.address().port, host: "127.0.0.1", allowHalfOpen: true });
        const client = tls.connect({ socket: raw, rejectUnauthorized: false });
        client.on("secureConnect", () => {
          client.write("CONNECT example.com:443 HTTP/1.1\\r\\nHost: example.com:443\\r\\n\\r\\n");
        });
        client.on("data", () => client.end());
        client.on("close", () => console.log("client:close"));
      });
    `;
      await using proc = Bun.spawn({
        cmd: [bunExe(), "-e", fixture],
        env: { ...bunEnv, CERT: tlsCert.cert, KEY: tlsCert.key },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      // Before the fix the server socket never closes: stdout stops at
      // server:finish and the process hangs until the test timeout. client:close
      // and server:close may interleave, so assert presence + server ordering.
      const lines = stdout.split("\n").filter(Boolean);
      expect({
        server: lines.filter(l => l.startsWith("server:")),
        hasClientClose: lines.includes("client:close"),
        stderr,
        exitCode,
      }).toEqual({
        server: ["server:end", "server:finish", "server:close"],
        hasClientClose: true,
        stderr: "",
        exitCode: 0,
      });
    },
  );

  test.each([
    ["default", "false"],
    ["explicit", "true"],
  ])("https upgrade sockets honor the %s half-open policy", async (_label, expected) => {
    const fixture = /* js */ `
      const https = require("node:https");
      const explicit = process.env.ALLOW_HALF_OPEN === "true";
      const deadline = setTimeout(() => {
        console.error("upgrade socket did not close");
        process.exit(1);
      }, 2000);
      let request;
      const server = https.createServer({
        cert: process.env.CERT,
        key: process.env.KEY,
        ...(explicit ? { allowHalfOpen: true } : {}),
      });
      server.on("upgrade", (_request, socket) => {
        console.log("allowHalfOpen:" + socket.allowHalfOpen);
        socket.resume();
        socket.on("end", () => {
          console.log("end:" + socket.writable + ":" + socket.writableEnded);
          if (explicit) socket.destroy();
        });
        socket.on("close", () => {
          console.log("socket:close");
          server.close(() => {
            clearTimeout(deadline);
            console.log("server:close");
          });
        });
        request.destroy();
      });
      server.listen(0, "127.0.0.1", () => {
        request = https.request({
          hostname: "127.0.0.1",
          port: server.address().port,
          rejectUnauthorized: false,
          headers: { Connection: "Upgrade", Upgrade: "websocket" },
        });
        request.on("error", () => {});
        request.end();
      });
    `;
    await using proc = Bun.spawn({
      cmd: [bunExe(), "-e", fixture],
      env: { ...bunEnv, CERT: tlsCert.cert, KEY: tlsCert.key, ALLOW_HALF_OPEN: expected },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr, exitCode }).toEqual({
      stdout: `allowHalfOpen:${expected}\nend:true:false\nsocket:close\nserver:close\n`,
      stderr: "",
      exitCode: 0,
    });
  });

  test.skipIf(isWindows)(
    "AF_UNIX CONNECT sockets whose peer closes first do not spin the loop on EPOLLHUP",
    async () => {
      // An AF_UNIX peer close() on a half-open (CONNECT hand-off) socket is EPOLLHUP, which is level-triggered:
      // the loop must stay idle while the server still holds its side, and each socket ends and closes once.
      using dir = tempDir("connect-unix-hangup", {});
      const result = await bunRun(join(import.meta.dir, "node-http-connect-unix-hangup-fixture.js"), {
        SOCK: join(String(dir), "proxy.sock"),
      });
      const perTarget = Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [`peer-${i}:443`, { ends: 1, closes: 1 }]),
      );
      expect(result).toEqual({
        stdout: JSON.stringify(perTarget) + "\nidle",
        stderr: "",
        exitCode: 0,
        signalCode: null,
      });
    },
  );
});

/**
 * Test variations using normal HTTP requests and res.socket
 * These tests should run in both Node.js and Bun
 */

describe("HTTP server socket access via normal requests", () => {
  test("should handle socket errors during normal requests", async () => {
    let errorHandled = false;

    await using server = http.createServer((req, res) => {
      const socket = res.socket!;

      socket.on("error", err => {
        errorHandled = true;
      });

      // Simulate an error condition
      setTimeout(() => {
        socket.destroy(new Error("Simulated error"));
      }, 50);
    });

    await once(server.listen(0, "127.0.0.1"), "listening");
    const serverAddress = server.address() as AddressInfo;

    const client = net.connect(serverAddress.port, serverAddress.address, () => {
      client.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
    });

    const { promise, resolve } = Promise.withResolvers<boolean>();

    client.on("error", () => {
      resolve(true);
    });

    client.on("close", () => {
      resolve(false);
    });

    await promise;
    expect(errorHandled).toBe(true);
  });

  test.todo("should handle socket pause/resume during request", async () => {
    const largeData = Buffer.alloc(1024 * 1024, "x").toString();
    let pauseCount = 0;
    let resumeCount = 0;

    await using server = http.createServer((req, res) => {
      const socket = res.socket!;

      // Monitor socket state
      const originalPause = socket.pause.bind(socket);
      const originalResume = socket.resume.bind(socket);

      socket.pause = function () {
        pauseCount++;
        return originalPause();
      };

      socket.resume = function () {
        resumeCount++;
        return originalResume();
      };

      // Send large response to trigger backpressure
      res.writeHead(200, { "Content-Type": "text/plain" });

      const sendData = () => {
        let ok = true;
        while (ok) {
          ok = res.write(largeData);
          if (!ok) {
            // Wait for drain event
            res.once("drain", sendData);
            break;
          }
        }
      };

      sendData();

      setTimeout(() => res.end(), 100);
    });

    await once(server.listen(0, "127.0.0.1"), "listening");
    const serverAddress = server.address() as AddressInfo;

    const client = net.connect(serverAddress.port, serverAddress.address, () => {
      client.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
    });

    const { promise, resolve } = Promise.withResolvers<number>();
    let bytesReceived = 0;

    // Slow reader to trigger backpressure
    client.on("data", chunk => {
      bytesReceived += chunk.length;
      client.pause();
      setTimeout(() => client.resume(), 10);
    });

    client.on("end", () => {
      resolve(bytesReceived);
    });

    const total = await promise;
    expect(total).toBeGreaterThan(0);
  });
});

describe("Should be compatible with node.js", () => {
  // https://github.com/oven-sh/bun/issues/34158
  test("server.close(cb) completes after a CONNECT handoff once both sockets are destroyed", async () => {
    const server = http.createServer();
    let serverSocket: net.Socket;
    server.on("connect", (req, socket) => {
      serverSocket = socket;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = (server.address() as AddressInfo)!;

    const request = http.request({ host: "127.0.0.1", port, method: "CONNECT", path: "example.com:80" });
    request.on("error", () => {});
    request.end();
    const [, clientSocket] = (await once(request, "connect")) as [unknown, net.Socket];

    clientSocket.destroy();
    serverSocket!.destroy();
    const { promise: closed, resolve: onClosed } = Promise.withResolvers<void>();
    server.close(() => onClosed());
    await closed;
  });

  test("tests should run on node.js", async () => {
    const process = Bun.spawn({
      cmd: [nodeExe(), "--test", join(import.meta.dir, "node-http-connect.node.mts")],
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
      env: bunEnv,
    });
    expect(await process.exited).toBe(0);
  });
  test("tests should run on bun", async () => {
    const process = Bun.spawn({
      cmd: [bunExe(), "test", join(import.meta.dir, "node-http-connect.node.mts")],
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
      env: bunEnv,
    });
    expect(await process.exited).toBe(0);
  });
});

// Windows: after FIN on a CONNECT-tunnel socket, AFD's level-triggered
// UV_DISCONNECT used to re-derive EOF and bounce the poll between 0 and
// WRITABLE forever (pins the poll_cb allow_half_open arm).
test("CONNECT: process exits after the tunnel socket is re-emitted as a connection and the server closes", async () => {
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `const http = require("node:http");
       let endCount = 0;
       let socketCloseCount = 0;
       let serverCloseCount = 0;
       const server = http.createServer(() => { throw new Error("request listener should not run"); });
       server.on("close", () => serverCloseCount++);
       server.on("connect", (req, socket) => {
         socket.on("end", () => endCount++);
         socket.on("close", () => socketCloseCount++);
         socket.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n");
         server.emit("connection", socket);
         server.close();
       });
       server.listen(0, () => {
         http.request({ port: server.address().port, method: "CONNECT" }).end();
       });
       process.on("exit", () => {
         if (endCount > 1) throw new Error("end fired " + endCount + " times (expected at most 1)");
         if (socketCloseCount !== 1 || serverCloseCount !== 1)
           throw new Error("close counts: " + socketCloseCount + "/" + serverCloseCount);
         console.log("ok");
       });`,
    ],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect({ stdout, stderr, exitCode, signalCode: proc.signalCode }).toEqual({
    stdout: "ok\n",
    stderr: "",
    exitCode: 0,
    signalCode: null,
  });
});

test.each([
  ["connect", "same"],
  ["connect", "foreign"],
  ["upgrade", "same"],
  ["upgrade", "foreign"],
])("reinjects a %s tunnel into a %s HTTP server", async (event, targetKind) => {
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `const http = require("node:http");
       const assert = require("node:assert/strict");
       const event = process.argv[1];
       const foreign = process.argv[2] === "foreign";
       const body = "parsed after native handoff";
       let requests = 0;
       let socketCloses = 0;
       let serverCloses = 0;
       const handler = (req, res) => {
         requests++;
         assert.equal(req.url, "/after-handoff");
         assert.equal(req.socket.server, target);
         res.writeHead(200, { "content-length": Buffer.byteLength(body) });
         res.end(body);
       };
       const original = http.createServer(foreign ? () => { throw Error("wrong parser owner"); } : handler);
       const target = foreign ? http.createServer(handler) : original;
       original.on("close", () => serverCloses++);
       original.on(event, (_req, socket) => {
         socket.on("close", () => socketCloses++);
         socket.write(event === "connect"
           ? "HTTP/1.1 200 Connection Established\\r\\n\\r\\n"
           : "HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: test\\r\\n\\r\\n");
         target.emit("connection", socket);
       });
       original.listen(0, "127.0.0.1", () => {
         const request = http.request({
           hostname: "127.0.0.1", port: original.address().port,
           method: event === "connect" ? "CONNECT" : "GET",
           path: event === "connect" ? "example.invalid:443" : "/",
           headers: event === "upgrade" ? { Connection: "Upgrade", Upgrade: "test" } : undefined,
         });
         request.on(event, (_response, socket, head) => {
           let wire = head;
           socket.on("data", chunk => { wire = Buffer.concat([wire, chunk]); });
           socket.on("end", () => {
             assert.ok(wire.toString().startsWith("HTTP/1.1 200"));
             assert.equal(wire.subarray(wire.indexOf("\\r\\n\\r\\n") + 4).toString(), body);
             original.close();
           });
           socket.write("GET /after-handoff HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n");
         });
         request.end();
       });
       process.on("exit", () => {
         assert.deepEqual({ requests, socketCloses, serverCloses }, { requests: 1, socketCloses: 1, serverCloses: 1 });
         console.log("ok");
       });`,
      event,
      targetKind,
    ],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect({ stdout, stderr, exitCode, signalCode: proc.signalCode }).toEqual({
    stdout: "ok\n",
    stderr: "",
    exitCode: 0,
    signalCode: null,
  });
});

test.each(["connect", "upgrade"])(
  "detached %s tunnel EOF releases loop activity without closing the socket",
  async event => {
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `const http = require("node:http");
       const assert = require("node:assert/strict");
       const event = process.argv[1];
       let ends = 0;
       let socketCloses = 0;
       let serverCloses = 0;
       let connections = -1;
       let tunnel;
       const server = http.createServer(() => { throw Error("unexpected HTTP request"); });
       server.on("close", () => serverCloses++);
       server.on(event, (_req, socket) => {
         tunnel = socket;
         socket.on("end", () => {
           ends++;
           server.getConnections((error, count) => {
             assert.ifError(error);
             connections = count;
           });
         });
         socket.on("close", () => socketCloses++);
         socket.write(event === "connect"
           ? "HTTP/1.1 200 Connection Established\\r\\n\\r\\n"
           : "HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: test\\r\\n\\r\\n");
         server.close();
       });
       server.listen(0, "127.0.0.1", () => {
         http.request({ hostname: "127.0.0.1", port: server.address().port,
           method: event === "connect" ? "CONNECT" : "GET",
           headers: event === "upgrade" ? { Connection: "Upgrade", Upgrade: "test" } : undefined,
         }).end();
       });
       process.on("exit", () => {
         const state = { ends, socketCloses, serverCloses, connections,
           readableEnded: tunnel.readableEnded, writable: tunnel.writable, destroyed: tunnel.destroyed };
         assert.deepEqual(state, { ends: 1, socketCloses: 0, serverCloses: 0, connections: 1,
           readableEnded: true, writable: true, destroyed: false });
         console.log(JSON.stringify(state));
       });`,
        event,
      ],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr, exitCode, signalCode: proc.signalCode }).toEqual({
      stdout:
        '{"ends":1,"socketCloses":0,"serverCloses":0,"connections":1,"readableEnded":true,"writable":true,"destroyed":false}\n',
      stderr: "",
      exitCode: 0,
      signalCode: null,
    });
  },
);

async function* readTunnelProcessLines(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      yield buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
    }
  }
  buffered += decoder.decode();
  if (buffered) yield buffered;
}

describe.each([
  ["connect", "http"],
  ["upgrade", "http"],
  ["connect", "https"],
])("detached %s %s tunnel liveness", (event, protocol) => {
  const modes =
    protocol === "https"
      ? ["write after FIN"]
      : ["default reference", "explicit reference", "unreferenced", "write before FIN", "write after FIN"];
  if (event === "upgrade") modes.push("write before upgrade body");
  test.each(modes)("%s", async mode => {
    const beforeBody = mode === "write before upgrade body";
    const pendingWrite = mode === "write before FIN" || mode === "write after FIN" || beforeBody;
    const payloadBytes = 8 * 1024 * 1024;
    const responseHead =
      event === "connect"
        ? "HTTP/1.1 200 Connection Established\r\n\r\n"
        : "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n";
    // The peer lives in the test process so it cannot keep the tunnel subprocess alive.
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `const http = require("node:http");
           const assert = require("node:assert/strict");
           const event = process.argv[1];
           const mode = process.argv[2];
           const protocol = process.argv[3];
           const beforeBody = mode === "write before upgrade body";
           const pendingWrite = mode === "write before FIN" || mode === "write after FIN" || beforeBody;
           const counts = { ends: 0, drains: 0, writes: 0, afterFinWrites: 0, probes: 0, closes: 0, serverCloses: 0 };
           let tunnel;
           const unexpectedRequest = () => { throw Error("unexpected HTTP request"); };
           const server = protocol === "https"
             ? require("node:https").createServer({ cert: process.env.CERT, key: process.env.KEY, allowHalfOpen: true }, unexpectedRequest)
             : http.createServer(unexpectedRequest);
           server.on("close", () => counts.serverCloses++);
           server.on(event, (_req, socket) => {
             tunnel = socket;
             socket.on("close", () => counts.closes++);
             socket.on("drain", () => counts.drains++);
             function writeAfterFin() {
               socket.write("after-fin", error => {
                 assert.ifError(error);
                 counts.afterFinWrites++;
                 socket.end();
               });
             }
             function reportPending() {
               setImmediate(() => {
                 assert.ok(socket.writableLength > 0);
                 assert.equal(counts.writes, 0);
                 assert.equal(counts.serverCloses, 0);
                 socket.unref();
                 console.log("pending");
               });
             }
             function writePayload() {
               const accepted = socket.write(Buffer.alloc(${payloadBytes}, "x"), error => {
                 assert.ifError(error);
                 counts.writes++;
                 if (beforeBody) {
                   assert.equal(counts.ends, 0);
                   socket.ref();
                   console.log("flushed");
                 } else {
                   assert.equal(counts.ends, 1);
                   writeAfterFin();
                 }
               });
               assert.equal(accepted, false);
             }
             socket.on("end", () => {
               counts.ends++;
               if (!pendingWrite) return;
               assert.equal(socket.writable, true);
               assert.equal(socket.destroyed, false);
               if (beforeBody) {
                 assert.equal(counts.writes, 1);
                 writeAfterFin();
                 return;
               }
               if (mode === "write after FIN") writePayload();
               reportPending();
             });
             if (pendingWrite) {
               socket.resume();
             } else if (mode !== "unreferenced") {
               let received = "";
               socket.on("data", chunk => {
                 received += chunk;
                 if (received.length < 4) return;
                 assert.equal(received, "ping");
                 counts.probes++;
                 socket.end("pong");
                 server.close();
               });
             }
             socket.write(${JSON.stringify(responseHead)}, error => {
               assert.ifError(error);
               if (pendingWrite) {
                 server.close();
                 console.log("ready");
                 if (mode === "write before FIN" || beforeBody) writePayload();
                 if (beforeBody) reportPending();
               } else {
                 if (mode === "explicit reference") socket.unref().ref();
                 if (mode === "unreferenced") socket.unref();
                 server.unref();
                 console.log("ready");
               }
             });
           });
           server.listen(0, "127.0.0.1", () => console.log(server.address().port));
           process.on("exit", () => {
             if (mode === "unreferenced") {
               assert.deepEqual(counts, { ends: 0, drains: 0, writes: 0, afterFinWrites: 0, probes: 0, closes: 0, serverCloses: 0 });
               assert.equal(server.listening, true);
               assert.equal(tunnel.writable, true);
               assert.equal(tunnel.destroyed, false);
             } else {
               assert.deepEqual(counts, { ends: 1, drains: pendingWrite ? 1 : 0,
                 writes: pendingWrite ? 1 : 0, afterFinWrites: pendingWrite ? 1 : 0,
                 probes: pendingWrite ? 0 : 1, closes: 1, serverCloses: 1 });
             }
             console.log("ok");
           });`,
        event,
        mode,
        protocol,
      ],
      env: protocol === "https" ? { ...bunEnv, CERT: tlsCert.cert, KEY: tlsCert.key } : bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const lines = readTunnelProcessLines(proc.stdout);
    const stderr = proc.stderr.text();
    const transportFailure = Promise.withResolvers<never>();
    void transportFailure.promise.catch(() => {});
    async function nextLine() {
      const { value, done } = await Promise.race([lines.next(), transportFailure.promise]);
      if (done) throw new Error("Tunnel subprocess exited before the expected lifecycle event");
      return value;
    }
    let client: net.Socket | undefined;
    try {
      const port = Number(await nextLine());
      expect(port).toBeGreaterThan(0);
      client =
        protocol === "https"
          ? tls.connect({ port, host: "127.0.0.1", rejectUnauthorized: false, allowHalfOpen: true })
          : net.connect({ port, host: "127.0.0.1" });
      if (pendingWrite) client.pause();
      const chunks: Buffer[] = [];
      client.on("data", chunk => chunks.push(chunk));
      client.on("error", transportFailure.reject);
      const closed = once(client, "close");
      void closed.catch(() => {});
      await once(client, protocol === "https" ? "secureConnect" : "connect");
      client.write(
        event === "connect"
          ? "CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n"
          : "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: test\r\n" +
              (beforeBody ? "Content-Length: 4\r\n" : "") +
              "\r\n",
      );
      expect(await nextLine()).toBe("ready");
      if (pendingWrite) {
        if (!beforeBody) client.end();
        expect(await nextLine()).toBe("pending");
        client.resume();
        if (beforeBody) {
          expect(await nextLine()).toBe("flushed");
          client.end("body");
        }
      } else if (mode !== "unreferenced") {
        client.write("ping");
      }
      const stdout = (async () => {
        let text = "";
        for await (const line of lines) text += line + "\n";
        return text;
      })();
      const [output, errors, exitCode] = await Promise.race([
        Promise.all([stdout, stderr, proc.exited, closed]),
        transportFailure.promise,
      ]);
      expect({ stdout: output, stderr: errors, exitCode, signalCode: proc.signalCode }).toEqual({
        stdout: "ok\n",
        stderr: "",
        exitCode: 0,
        signalCode: null,
      });
      expect(Buffer.concat(chunks)).toEqual(
        pendingWrite
          ? Buffer.concat([Buffer.from(responseHead), Buffer.alloc(payloadBytes, "x"), Buffer.from("after-fin")])
          : Buffer.from(responseHead + (mode === "unreferenced" ? "" : "pong")),
      );
    } finally {
      client?.destroy();
    }
  });
});

test("detached HTTPS CONNECT preserves successive writes started from drain", async () => {
  const payloadBytes = 8 * 1024 * 1024;
  const responseHead = "HTTP/1.1 200 Connection Established\r\n\r\n";
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `const https = require("node:https");
       const assert = require("node:assert/strict");
       const counts = { drains: 0, firstWrites: 0, secondWrites: 0, ends: 0, closes: 0, serverCloses: 0 };
       const server = https.createServer({
         cert: process.env.CERT, key: process.env.KEY, allowHalfOpen: true,
       }, () => { throw Error("unexpected HTTP request"); });
       server.on("close", () => counts.serverCloses++);
       server.on("connect", (_req, socket) => {
         socket.resume();
         socket.on("end", () => counts.ends++);
         socket.on("close", () => counts.closes++);
         socket.on("drain", () => {
           counts.drains++;
           assert.ok(counts.drains <= 2);
           assert.equal(socket.writableLength, 0);
           if (counts.drains !== 1) return;

           socket.ref();
           socket.cork();
           const accepted = socket.write(Buffer.alloc(${payloadBytes}, "y"), error => {
             assert.ifError(error);
             counts.secondWrites++;
             assert.equal(counts.firstWrites, 1);
             assert.equal(counts.drains, 2);
             socket.end();
           });
           assert.equal(accepted, false);
           socket.uncork();
         });
         socket.write(${JSON.stringify(responseHead)}, error => {
           assert.ifError(error);
           server.close();
           const accepted = socket.write(Buffer.alloc(${payloadBytes}, "x"), error => {
             assert.ifError(error);
             counts.firstWrites++;
             assert.equal(counts.drains, 1);
           });
           assert.equal(accepted, false);
           setImmediate(() => {
             assert.ok(socket.writableLength > 0);
             assert.equal(counts.drains, 0);
             assert.equal(counts.firstWrites, 0);
             assert.equal(counts.secondWrites, 0);
             socket.unref();
             console.log("pending");
           });
         });
       });
       server.listen(0, "127.0.0.1", () => console.log(server.address().port));
       process.on("exit", () => {
         assert.deepEqual(counts, { drains: 2, firstWrites: 1, secondWrites: 1, ends: 1, closes: 1, serverCloses: 1 });
         console.log("ok");
       });`,
    ],
    env: { ...bunEnv, CERT: tlsCert.cert, KEY: tlsCert.key },
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines = readTunnelProcessLines(proc.stdout);
  const stderr = proc.stderr.text();
  const transportFailure = Promise.withResolvers<never>();
  void transportFailure.promise.catch(() => {});
  async function nextLine() {
    const { value, done } = await Promise.race([lines.next(), transportFailure.promise]);
    if (done) throw new Error("Tunnel subprocess exited before the expected lifecycle event");
    return value;
  }
  let client: tls.TLSSocket | undefined;
  try {
    const port = Number(await nextLine());
    expect(port).toBeGreaterThan(0);
    client = tls.connect({ port, host: "127.0.0.1", rejectUnauthorized: false, allowHalfOpen: true });
    client.pause();
    const chunks: Buffer[] = [];
    let peerEnds = 0;
    let peerCloses = 0;
    const peer = client;
    client.on("data", chunk => chunks.push(chunk));
    client.on("error", transportFailure.reject);
    client.on("end", () => {
      peerEnds++;
      peer.end();
    });
    client.on("close", () => peerCloses++);
    const closed = once(client, "close");
    void closed.catch(() => {});
    await once(client, "secureConnect");
    client.write("CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n");
    expect(await nextLine()).toBe("pending");
    client.resume();

    const stdout = (async () => {
      let text = "";
      for await (const line of lines) text += line + "\n";
      return text;
    })();
    const [output, errors, exitCode] = await Promise.race([
      Promise.all([stdout, stderr, proc.exited, closed]),
      transportFailure.promise,
    ]);
    expect({ stdout: output, stderr: errors, exitCode, signalCode: proc.signalCode, peerEnds, peerCloses }).toEqual({
      stdout: "ok\n",
      stderr: "",
      exitCode: 0,
      signalCode: null,
      peerEnds: 1,
      peerCloses: 1,
    });
    expect(Buffer.concat(chunks)).toEqual(
      Buffer.concat([Buffer.from(responseHead), Buffer.alloc(payloadBytes, "x"), Buffer.alloc(payloadBytes, "y")]),
    );
  } finally {
    client?.destroy();
  }
});
