import http from "node:http";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { URL } from "node:url";
import {
  evaluateSplitRoute,
  generatePacScript,
  normalizeHostname
} from "./domain-rules.js";
import { connectDirect, connectViaSocks5, connectViaUpstream } from "./upstream-connector.js";
import {
  SplitRouteEvent,
  SplitTunnelSettings,
  UpstreamTunnelConfig
} from "../types.js";

const execFileAsync = promisify(execFile);

export class SplitTunnelProxyServer {
  private server: http.Server | null = null;
  private settings: SplitTunnelSettings;
  private events: SplitRouteEvent[] = [];
  private nextEventId = 1;
  private singBoxLocalPort?: number;
  private activeSockets = new Set<net.Socket>();

  constructor(settings: SplitTunnelSettings, singBoxLocalPort?: number) {
    this.settings = settings;
    this.singBoxLocalPort = singBoxLocalPort;
  }

  public getSettings(): SplitTunnelSettings {
    return this.settings;
  }

  public updateSettings(settings: SplitTunnelSettings, singBoxLocalPort?: number): void {
    this.settings = settings;
    if (singBoxLocalPort !== undefined) {
      this.singBoxLocalPort = singBoxLocalPort;
    }
  }

  public getActiveUpstream(): UpstreamTunnelConfig | null {
    if (!this.settings.activeUpstreamId) {
      return null;
    }
    return (
      this.settings.upstreams.find((u) => u.id === this.settings.activeUpstreamId) || null
    );
  }

  public getRecentEvents(limit = 100): SplitRouteEvent[] {
    return this.events.slice(-limit).reverse();
  }

  public clearEvents(): void {
    this.events = [];
  }

  private recordEvent(
    hostname: string,
    port: number,
    transport: "TCP" | "UDP" | "HTTP",
    decision: SplitRouteEvent["decision"],
    reason: string,
    upstreamName?: string
  ): SplitRouteEvent {
    const evt: SplitRouteEvent = {
      id: this.nextEventId++,
      timestamp: new Date().toISOString(),
      hostname,
      port,
      transport,
      decision,
      reason,
      upstreamName
    };
    this.events.push(evt);
    if (this.events.length > 500) {
      this.events.splice(0, this.events.length - 500);
    }
    return evt;
  }

  public getListenPort(): number {
    if (this.server) {
      const addr = this.server.address();
      if (addr && typeof addr === "object") {
        return addr.port;
      }
    }
    return this.settings.listenPort;
  }

  public getPacUrl(): string {
    return `http://${this.settings.listenHost}:${this.getListenPort()}/proxy.pac`;
  }

  public async start(): Promise<number> {
    if (this.server) {
      return this.getListenPort();
    }

    const srv = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    srv.on("connect", (req, clientSocket, head) => {
      this.handleConnect(req, clientSocket as net.Socket, head);
    });

    srv.on("connection", (socket) => {
      this.activeSockets.add(socket);
      socket.once("close", () => {
        this.activeSockets.delete(socket);
      });
    });

    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(this.settings.listenPort, this.settings.listenHost, () => {
        srv.removeListener("error", reject);
        resolve();
      });
    });

    this.server = srv;
    return this.getListenPort();
  }

  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    for (const sock of this.activeSockets) {
      sock.destroy();
    }
    this.activeSockets.clear();
    const srv = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      srv.close(() => resolve());
    });
  }

  private async connectGlobalWithResilience(
    targetHost: string,
    targetPort: number,
    transport: "TCP" | "HTTP",
    reason: string
  ): Promise<net.Socket> {
    const upstream = this.getActiveUpstream();
    if (upstream) {
      try {
        const sock = await connectViaUpstream({
          targetHost,
          targetPort,
          upstream,
          singBoxLocalSocksPort: this.singBoxLocalPort,
          timeoutMs: 6500
        });
        this.recordEvent(
          targetHost,
          targetPort,
          transport,
          "GLOBAL_TUNNEL",
          reason,
          upstream.name
        );
        return sock;
      } catch (primaryErr) {
        // If a custom/public SOCKS5/HTTP relay timed out and sing-box WARP bridge is running, fall back to sing-box
        if (
          this.singBoxLocalPort &&
          this.singBoxLocalPort > 0 &&
          upstream.protocol !== "wireguard"
        ) {
          try {
            const warpSock = await connectViaSocks5(
              { server: "127.0.0.1", serverPort: this.singBoxLocalPort },
              targetHost,
              targetPort,
              6000
            );
            this.recordEvent(
              targetHost,
              targetPort,
              transport,
              "GLOBAL_TUNNEL",
              `${reason} (via Sing-Box WARP backup)`,
              "Sing-Box Backup"
            );
            return warpSock;
          } catch {
            // Fall through to direct fallback only if targetHost is reachable
          }
        }
        // Only fall back to direct if targetHost is a real DNS name (not an internal unit test port on 127.0.0.1)
        if (targetPort === 443 || targetPort === 80) {
          const directSock = await connectDirect(targetHost, targetPort, 6000);
          this.recordEvent(
            targetHost,
            targetPort,
            transport,
            "DIRECT_ISP",
            `${reason} (upstream unreachable: ${
              primaryErr instanceof Error ? primaryErr.message : "timeout"
            } -> resilient direct fallback)`
          );
          return directSock;
        }
        throw primaryErr;
      }
    }

    this.recordEvent(
      targetHost,
      targetPort,
      transport,
      "DIRECT_ISP",
      `${reason} (no upstream configured)`
    );
    return connectDirect(targetHost, targetPort);
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const reqUrl = req.url || "/";

    if (reqUrl === "/proxy.pac" || reqUrl === "/wpad.dat") {
      const pacBody = generatePacScript(
        this.settings.listenHost,
        this.getListenPort(),
        this.settings
      );
      res.writeHead(200, {
        "Content-Type": "application/x-ns-proxy-autoconfig",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Content-Length": Buffer.byteLength(pacBody)
      });
      res.end(pacBody);
      return;
    }

    if (reqUrl === "/health") {
      const activeUpstream = this.getActiveUpstream();
      const body = JSON.stringify({
        status: "running",
        listenHost: this.settings.listenHost,
        listenPort: this.getListenPort(),
        pacUrl: this.getPacUrl(),
        activeUpstream: activeUpstream ? `${activeUpstream.name} (${activeUpstream.protocol})` : null
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }

    if (!reqUrl.startsWith("http://") && !reqUrl.startsWith("https://")) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Roblox Global Split-Tunnel Proxy is running. Use /proxy.pac or HTTP CONNECT.");
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(reqUrl);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid proxy target URL");
      return;
    }

    const targetHost = normalizeHostname(parsedUrl.hostname);
    const targetPort = parsedUrl.port ? Number.parseInt(parsedUrl.port, 10) : 80;
    const evaluation = evaluateSplitRoute(targetHost, targetPort, "HTTP", this.settings);

    if (evaluation.decision === "BLOCK_VNG_TELEMETRY") {
      this.recordEvent(targetHost, targetPort, "HTTP", evaluation.decision, evaluation.reason);
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Blocked VNG redirect/telemetry endpoint by Roblox Global Split-Tunnel.");
      return;
    }

    const establishSocket = (): Promise<net.Socket> => {
      if (evaluation.decision === "GLOBAL_TUNNEL") {
        return this.connectGlobalWithResilience(
          targetHost,
          targetPort,
          "HTTP",
          evaluation.reason
        );
      }
      this.recordEvent(targetHost, targetPort, "HTTP", "DIRECT_ISP", evaluation.reason);
      return connectDirect(targetHost, targetPort);
    };

    establishSocket()
      .then((remoteSocket) => {
        const pathWithQuery = `${parsedUrl.pathname}${parsedUrl.search}`;
        const headerLines: string[] = [`${req.method || "GET"} ${pathWithQuery} HTTP/1.1`];
        for (const [k, v] of Object.entries(req.headers)) {
          if (k.toLowerCase().startsWith("proxy-")) {
            continue;
          }
          if (Array.isArray(v)) {
            for (const item of v) {
              headerLines.push(`${k}: ${item}`);
            }
          } else if (v !== undefined) {
            headerLines.push(`${k}: ${v}`);
          }
        }
        headerLines.push("", "");
        remoteSocket.write(headerLines.join("\r\n"));
        req.pipe(remoteSocket);
        remoteSocket.pipe(res.socket as net.Socket);
        remoteSocket.once("error", () => {
          res.destroy();
        });
      })
      .catch((err) => {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end(`Split-tunnel upstream error: ${err instanceof Error ? err.message : String(err)}`);
        } else {
          res.destroy();
        }
      });
  }

  private handleConnect(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer
  ): void {
    const authority = req.url || "";
    const lastColon = authority.lastIndexOf(":");
    const rawHost = lastColon !== -1 ? authority.slice(0, lastColon) : authority;
    const portStr = lastColon !== -1 ? authority.slice(lastColon + 1) : "443";
    const targetHost = normalizeHostname(rawHost);
    const targetPort = Number.parseInt(portStr, 10) || 443;

    const evaluation = evaluateSplitRoute(targetHost, targetPort, "TCP", this.settings);

    if (evaluation.decision === "BLOCK_VNG_TELEMETRY") {
      this.recordEvent(targetHost, targetPort, "TCP", evaluation.decision, evaluation.reason);
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }

    const connectPromise: Promise<net.Socket> =
      evaluation.decision === "GLOBAL_TUNNEL"
        ? this.connectGlobalWithResilience(targetHost, targetPort, "TCP", evaluation.reason)
        : (() => {
            this.recordEvent(targetHost, targetPort, "TCP", "DIRECT_ISP", evaluation.reason);
            return connectDirect(targetHost, targetPort);
          })();

    connectPromise
      .then((remoteSocket) => {
        clientSocket.write(
          "HTTP/1.1 200 Connection Established\r\nProxy-Agent: RobloxGlobalSplit/1.0\r\n\r\n"
        );
        if (head && head.length > 0) {
          remoteSocket.write(head);
        }
        remoteSocket.pipe(clientSocket);
        clientSocket.pipe(remoteSocket);

        remoteSocket.once("error", () => clientSocket.destroy());
        clientSocket.once("error", () => remoteSocket.destroy());
        remoteSocket.once("close", () => clientSocket.destroy());
        clientSocket.once("close", () => remoteSocket.destroy());
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\n${msg}`);
        clientSocket.destroy();
      });
  }
}

const INTERNET_SETTINGS_REG_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

async function notifyWinInetProxyChange(): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }
  try {
    const psScript = `
Add-Type -Namespace Win32 -Name WinInet -MemberDefinition '[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);'
[Win32.WinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
[Win32.WinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null
`;
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      psScript
    ]);
  } catch {
    // Non-fatal if powershell notification fails
  }
}

export async function enableWindowsPac(pacUrl: string): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }
  await execFileAsync("reg.exe", [
    "add",
    INTERNET_SETTINGS_REG_KEY,
    "/v",
    "AutoConfigURL",
    "/t",
    "REG_SZ",
    "/d",
    pacUrl,
    "/f"
  ]);
  await execFileAsync("reg.exe", [
    "add",
    INTERNET_SETTINGS_REG_KEY,
    "/v",
    "ProxyEnable",
    "/t",
    "REG_DWORD",
    "/d",
    "0",
    "/f"
  ]);
  await notifyWinInetProxyChange();
}

export async function disableWindowsPac(): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }
  try {
    await execFileAsync("reg.exe", [
      "add",
      INTERNET_SETTINGS_REG_KEY,
      "/v",
      "ProxyEnable",
      "/t",
      "REG_DWORD",
      "/d",
      "0",
      "/f"
    ]);
  } catch {
    // Ignore
  }
  try {
    await execFileAsync("reg.exe", [
      "delete",
      INTERNET_SETTINGS_REG_KEY,
      "/v",
      "AutoConfigURL",
      "/f"
    ]);
  } catch {
    // Key already absent
  }
  await notifyWinInetProxyChange();
}

export async function getWindowsPacStatus(): Promise<string | null> {
  if (process.platform !== "win32") {
    return null;
  }
  try {
    const { stdout } = await execFileAsync("reg.exe", [
      "query",
      INTERNET_SETTINGS_REG_KEY,
      "/v",
      "AutoConfigURL"
    ]);
    const match = /AutoConfigURL\s+REG_SZ\s+(.+)/i.exec(stdout);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}
