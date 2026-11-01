import net from "node:net";
import tls from "node:tls";
import {
  HttpTunnelConfig,
  Socks5TunnelConfig,
  UpstreamTunnelConfig
} from "../types.js";

export interface TunnelConnectOptions {
  targetHost: string;
  targetPort: number;
  upstream: UpstreamTunnelConfig;
  singBoxLocalSocksPort?: number;
  timeoutMs?: number;
}

/**
 * Connects directly to targetHost:targetPort over the local ISP interface.
 */
export function connectDirect(
  targetHost: string,
  targetPort: number,
  timeoutMs = 12000
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: targetHost, port: targetPort });
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error(`Direct connection timed out to ${targetHost}:${targetPort}`));
      }
    }, timeoutMs);

    socket.once("connect", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(socket);
      }
    });

    socket.once("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

/**
 * Establishes a tunnel through a SOCKS5 upstream server (RFC 1928 + RFC 1929 auth).
 */
export function connectViaSocks5(
  config: Pick<Socks5TunnelConfig, "server" | "serverPort" | "username" | "password">,
  targetHost: string,
  targetPort: number,
  timeoutMs = 15000
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: config.server, port: config.serverPort });
    let settled = false;

    const fail = (err: Error): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      }
    };

    const timer = setTimeout(() => {
      fail(new Error(`SOCKS5 handshake timed out via ${config.server}:${config.serverPort}`));
    }, timeoutMs);

    const readBytes = (minLength: number): Promise<Buffer> => {
      return new Promise((resRead, rejRead) => {
        let chunks = Buffer.alloc(0);
        const onData = (chunk: Buffer): void => {
          chunks = Buffer.concat([chunks, chunk]);
          if (chunks.length >= minLength) {
            socket.removeListener("data", onData);
            socket.removeListener("error", onErr);
            socket.removeListener("close", onClose);
            resRead(chunks);
          }
        };
        const onErr = (err: Error): void => {
          socket.removeListener("data", onData);
          socket.removeListener("close", onClose);
          rejRead(err);
        };
        const onClose = (): void => {
          socket.removeListener("data", onData);
          socket.removeListener("error", onErr);
          rejRead(new Error("SOCKS5 socket closed prematurely during handshake"));
        };
        socket.on("data", onData);
        socket.once("error", onErr);
        socket.once("close", onClose);
      });
    };

    socket.once("error", fail);

    socket.once("connect", async () => {
      try {
        const hasAuth = Boolean(config.username && config.username.length > 0);
        // Greeting: VER=0x05, NMETHODS, METHODS (0x00 No Auth, 0x02 Username/Password)
        const greeting = hasAuth
          ? Buffer.from([0x05, 0x02, 0x00, 0x02])
          : Buffer.from([0x05, 0x01, 0x00]);
        socket.write(greeting);

        const methodReply = await readBytes(2);
        if (methodReply[0] !== 0x05) {
          throw new Error(`Invalid SOCKS version in server greeting: ${methodReply[0]}`);
        }
        const selectedMethod = methodReply[1];
        if (selectedMethod === 0xff) {
          throw new Error("SOCKS5 server rejected all authentication methods");
        }

        if (selectedMethod === 0x02) {
          const userBuf = Buffer.from(config.username || "", "utf8");
          const passBuf = Buffer.from(config.password || "", "utf8");
          if (userBuf.length > 255 || passBuf.length > 255) {
            throw new Error("SOCKS5 username or password exceeds 255 bytes");
          }
          const authPacket = Buffer.concat([
            Buffer.from([0x01, userBuf.length]),
            userBuf,
            Buffer.from([passBuf.length]),
            passBuf
          ]);
          socket.write(authPacket);

          const authReply = await readBytes(2);
          if (authReply[1] !== 0x00) {
            throw new Error(`SOCKS5 username/password authentication failed (status=${authReply[1]})`);
          }
        } else if (selectedMethod !== 0x00) {
          throw new Error(`Unsupported SOCKS5 auth method selected by server: ${selectedMethod}`);
        }

        // Send CONNECT request (CMD=0x01)
        const hostBytes = Buffer.from(targetHost, "utf8");
        if (hostBytes.length > 255) {
          throw new Error(`Target hostname too long for SOCKS5: ${targetHost}`);
        }
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(targetPort, 0);

        // ATYP=0x03 (DOMAINNAME) so DNS resolution also happens on the remote non-VN proxy
        const connectReq = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBytes.length]),
          hostBytes,
          portBuf
        ]);
        socket.write(connectReq);

        const respHeader = await readBytes(4);
        if (respHeader[0] !== 0x05) {
          throw new Error(`Invalid SOCKS5 response version: ${respHeader[0]}`);
        }
        if (respHeader[1] !== 0x00) {
          throw new Error(`SOCKS5 CONNECT failed with code 0x${respHeader[1].toString(16)} for ${targetHost}:${targetPort}`);
        }

        const atyp = respHeader[3];
        let totalExpected = 4;
        let currentBuf = respHeader;

        if (atyp === 0x01) {
          // IPv4 (4 bytes) + port (2 bytes)
          totalExpected = 10;
        } else if (atyp === 0x04) {
          // IPv6 (16 bytes) + port (2 bytes)
          totalExpected = 22;
        } else if (atyp === 0x03) {
          if (currentBuf.length < 5) {
            const extra = await readBytes(5 - currentBuf.length);
            currentBuf = Buffer.concat([currentBuf, extra]);
          }
          const domainLen = currentBuf[4];
          totalExpected = 4 + 1 + domainLen + 2;
        } else {
          throw new Error(`Unknown SOCKS5 address type in reply: ${atyp}`);
        }

        if (currentBuf.length < totalExpected) {
          const rest = await readBytes(totalExpected - currentBuf.length);
          currentBuf = Buffer.concat([currentBuf, rest]);
        }

        const leftover = currentBuf.subarray(totalExpected);
        if (leftover.length > 0) {
          socket.unshift(leftover);
        }

        if (!settled) {
          settled = true;
          clearTimeout(timer);
          socket.removeListener("error", fail);
          resolve(socket);
        }
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

/**
 * Establishes a tunnel through an HTTP/HTTPS proxy server using HTTP CONNECT.
 */
export function connectViaHttpProxy(
  config: HttpTunnelConfig,
  targetHost: string,
  targetPort: number,
  timeoutMs = 15000
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const rawSocket: net.Socket = config.tls
      ? tls.connect({
          host: config.server,
          port: config.serverPort,
          servername: config.server
        })
      : net.connect({
          host: config.server,
          port: config.serverPort
        });

    let settled = false;
    const fail = (err: Error): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rawSocket.destroy();
        reject(err);
      }
    };

    const timer = setTimeout(() => {
      fail(new Error(`HTTP proxy CONNECT timed out via ${config.server}:${config.serverPort}`));
    }, timeoutMs);

    rawSocket.once("error", fail);

    const connectEvent = config.tls ? "secureConnect" : "connect";
    rawSocket.once(connectEvent, () => {
      const headers = [
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
        `Host: ${targetHost}:${targetPort}`,
        "Proxy-Connection: Keep-Alive"
      ];
      if (config.username) {
        const credentials = Buffer.from(
          `${config.username}:${config.password || ""}`,
          "utf8"
        ).toString("base64");
        headers.push(`Proxy-Authorization: Basic ${credentials}`);
      }
      headers.push("", "");
      rawSocket.write(headers.join("\r\n"));

      let responseBuf = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        responseBuf = Buffer.concat([responseBuf, chunk]);
        const headerEnd = responseBuf.indexOf("\r\n\r\n");
        if (headerEnd !== -1) {
          rawSocket.removeListener("data", onData);
          const headerText = responseBuf.subarray(0, headerEnd).toString("utf8");
          const statusLine = headerText.split("\r\n")[0] || "";
          const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})/i.exec(statusLine);
          const statusCode = statusMatch ? Number.parseInt(statusMatch[1], 10) : 0;

          if (statusCode !== 200) {
            fail(new Error(`Upstream HTTP proxy rejected CONNECT with status: ${statusLine}`));
            return;
          }

          const bodyRemainder = responseBuf.subarray(headerEnd + 4);
          if (bodyRemainder.length > 0) {
            rawSocket.unshift(bodyRemainder);
          }

          if (!settled) {
            settled = true;
            clearTimeout(timer);
            rawSocket.removeListener("error", fail);
            resolve(rawSocket);
          }
        }
      };

      rawSocket.on("data", onData);
    });
  });
}

/**
 * Connects to targetHost:targetPort via the configured UpstreamTunnelConfig.
 */
export async function connectViaUpstream(options: TunnelConnectOptions): Promise<net.Socket> {
  const { targetHost, targetPort, upstream, singBoxLocalSocksPort, timeoutMs } = options;

  if (upstream.protocol === "socks5") {
    return connectViaSocks5(upstream, targetHost, targetPort, timeoutMs);
  }

  if (upstream.protocol === "http") {
    return connectViaHttpProxy(upstream, targetHost, targetPort, timeoutMs);
  }

  // For WireGuard/WARP, VLESS, and Shadowsocks, route through the local sing-box bridge port if active
  if (singBoxLocalSocksPort && singBoxLocalSocksPort > 0) {
    return connectViaSocks5(
      {
        server: "127.0.0.1",
        serverPort: singBoxLocalSocksPort
      },
      targetHost,
      targetPort,
      timeoutMs
    );
  }

  throw new Error(
    `Upstream protocol '${upstream.protocol}' requires sing-box binary in PATH or a SOCKS5/HTTP upstream configured.`
  );
}
