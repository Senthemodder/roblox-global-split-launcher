import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { ConfigStore } from "../config-store.js";
import {
  SplitTunnelProxyServer,
  disableWindowsPac,
  enableWindowsPac,
  getWindowsPacStatus
} from "../proxy/split-proxy.js";
import { parseTunnelUri } from "../proxy/domain-rules.js";
import { generateSingBoxConfig } from "../proxy/singbox-config.js";
import { SingBoxBridgeRunner } from "../proxy/singbox-runner.js";
import { provisionCloudflareWarpTunnel } from "../proxy/warp-provisioner.js";
import {
  detectLocalInstallations,
  downloadGlobalBootstrapperExe,
  fetchGlobalWindowsPlayerVersion,
  launchGlobalRobloxClient,
  registerGlobalRobloxProtocol
} from "../bootstrapper/roblox-bootstrapper.js";
import {
  checkRegionAndSplitStatus,
  searchGlobalCatalog
} from "../catalog/global-catalog.js";

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

export class DashboardServer {
  private server: http.Server | null = null;
  private readonly store: ConfigStore;
  private readonly splitProxy: SplitTunnelProxyServer;
  private readonly singBoxRunner: SingBoxBridgeRunner;
  private uiPort: number;

  constructor(
    store: ConfigStore,
    splitProxy: SplitTunnelProxyServer,
    uiPort = 7898,
    singBoxRunner?: SingBoxBridgeRunner
  ) {
    this.store = store;
    this.splitProxy = splitProxy;
    this.uiPort = uiPort;
    this.singBoxRunner = singBoxRunner || new SingBoxBridgeRunner(7897);
  }

  public async syncActiveUpstreamEngine(): Promise<void> {
    const active = this.splitProxy.getActiveUpstream();
    if (!active) {
      await this.singBoxRunner.stop();
      this.splitProxy.updateSettings(this.store.getSettings(), undefined);
      return;
    }

    if (
      active.protocol === "wireguard" ||
      active.protocol === "vless" ||
      active.protocol === "shadowsocks"
    ) {
      const bridgePort = await this.singBoxRunner.startWithUpstream(
        active,
        this.store.getSettings()
      );
      this.splitProxy.updateSettings(this.store.getSettings(), bridgePort);
    } else {
      await this.singBoxRunner.stop();
      this.splitProxy.updateSettings(this.store.getSettings(), undefined);
    }
  }

  public async start(): Promise<number> {
    if (this.server) {
      return this.uiPort;
    }

    const srv = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        sendJson(res, 500, {
          error: err instanceof Error ? err.message : String(err)
        });
      });
    });

    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(this.uiPort, "127.0.0.1", () => {
        srv.removeListener("error", reject);
        const addr = srv.address();
        if (addr && typeof addr === "object") {
          this.uiPort = addr.port;
        }
        resolve();
      });
    });

    this.server = srv;
    return this.uiPort;
  }

  public async stop(): Promise<void> {
    await this.singBoxRunner.stop();
    if (!this.server) {
      return;
    }
    const srv = this.server;
    this.server = null;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  public getUrl(): string {
    return `http://127.0.0.1:${this.uiPort}`;
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const parsedUrl = new URL(req.url || "/", `http://127.0.0.1:${this.uiPort}`);
    const pathname = parsedUrl.pathname;
    const method = (req.method || "GET").toUpperCase();

    if (method === "GET" && pathname === "/") {
      const html = this.renderDashboardHtml();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (method === "GET" && pathname === "/api/state") {
      const settings = this.store.getSettings();
      const winPac = await getWindowsPacStatus();
      const installations = detectLocalInstallations();
      const events = this.splitProxy.getRecentEvents(100);
      sendJson(res, 200, {
        settings,
        proxyListenPort: this.splitProxy.getListenPort(),
        pacUrl: this.splitProxy.getPacUrl(),
        windowsAutoConfigUrl: winPac,
        activeUpstream: this.splitProxy.getActiveUpstream(),
        singBoxRunning: this.singBoxRunner.isRunning(),
        singBoxLogs: this.singBoxRunner.getRecentLogs(),
        installations,
        recentEvents: events
      });
      return;
    }

    if (method === "POST" && pathname === "/api/settings") {
      const body = await readJsonBody(req);
      const patch: Record<string, unknown> = {};
      if (typeof body.routeRbxCdnDirect === "boolean") {
        patch.routeRbxCdnDirect = body.routeRbxCdnDirect;
      }
      if (typeof body.blockVngRedirects === "boolean") {
        patch.blockVngRedirects = body.blockVngRedirects;
      }
      if (typeof body.autoConfigureWindowsPac === "boolean") {
        patch.autoConfigureWindowsPac = body.autoConfigureWindowsPac;
      }
      if (typeof body.activeUpstreamId === "string" || body.activeUpstreamId === null) {
        patch.activeUpstreamId = body.activeUpstreamId;
      }

      const updated = this.store.updateSettings(patch);
      this.splitProxy.updateSettings(
        updated,
        this.singBoxRunner.isRunning() ? this.singBoxRunner.getBridgePort() : undefined
      );

      if (typeof body.activeUpstreamId !== "undefined") {
        await this.syncActiveUpstreamEngine();
      }

      if (typeof body.autoConfigureWindowsPac === "boolean") {
        if (body.autoConfigureWindowsPac) {
          await enableWindowsPac(this.splitProxy.getPacUrl());
        } else {
          await disableWindowsPac();
        }
      }

      sendJson(res, 200, { settings: updated });
      return;
    }

    if (method === "POST" && pathname === "/api/upstreams/uri") {
      const body = await readJsonBody(req);
      const uri = typeof body.uri === "string" ? body.uri.trim() : "";
      const name = typeof body.name === "string" ? body.name.trim() : undefined;
      if (!uri) {
        sendJson(res, 400, { error: "Missing 'uri' field" });
        return;
      }
      const parsed = parseTunnelUri(uri, name);
      const updated = this.store.addUpstream(parsed, true);
      this.splitProxy.updateSettings(updated);
      await this.syncActiveUpstreamEngine();
      sendJson(res, 200, { added: parsed, settings: updated });
      return;
    }

    if (method === "POST" && pathname === "/api/upstreams/provision-warp") {
      const warpTunnel = await provisionCloudflareWarpTunnel();
      const updated = this.store.addUpstream(warpTunnel, true);
      this.splitProxy.updateSettings(updated);
      await this.syncActiveUpstreamEngine();
      sendJson(res, 200, { added: warpTunnel, settings: updated });
      return;
    }

    if (method === "DELETE" && pathname.startsWith("/api/upstreams/")) {
      const id = decodeURIComponent(pathname.slice("/api/upstreams/".length));
      const updated = this.store.removeUpstream(id);
      this.splitProxy.updateSettings(updated);
      await this.syncActiveUpstreamEngine();
      sendJson(res, 200, { settings: updated });
      return;
    }

    if (method === "GET" && pathname === "/api/singbox-config") {
      const active = this.splitProxy.getActiveUpstream();
      if (!active) {
        sendJson(res, 400, {
          error: "Add and select an upstream tunnel profile first to generate a sing-box config."
        });
        return;
      }
      const enableTun = parsedUrl.searchParams.get("tun") === "1";
      const config = generateSingBoxConfig(active, this.store.getSettings(), enableTun);
      sendJson(res, 200, config);
      return;
    }

    if (method === "GET" && pathname === "/api/region-check") {
      const active = this.splitProxy.getActiveUpstream();
      const report = await checkRegionAndSplitStatus({
        proxyHost: this.store.getSettings().listenHost,
        proxyPort: this.splitProxy.getListenPort(),
        hasActiveUpstream: Boolean(active),
        activeUpstream: active,
        singBoxLocalSocksPort: this.singBoxRunner.isRunning()
          ? this.singBoxRunner.getBridgePort()
          : undefined
      });
      sendJson(res, 200, report);
      return;
    }

    if (method === "GET" && pathname === "/api/roblox/version") {
      const [liveVersion, localInstall] = await Promise.all([
        fetchGlobalWindowsPlayerVersion(),
        Promise.resolve(detectLocalInstallations())
      ]);
      sendJson(res, 200, {
        liveVersion,
        localInstall
      });
      return;
    }

    if (method === "POST" && pathname === "/api/roblox/download-installer") {
      const liveVersion = await fetchGlobalWindowsPlayerVersion();
      const destDir = path.join(process.cwd(), ".runtime", "installers");
      const filePath = await downloadGlobalBootstrapperExe(
        liveVersion.clientVersionUpload,
        destDir
      );
      sendJson(res, 200, {
        version: liveVersion.version,
        clientVersionUpload: liveVersion.clientVersionUpload,
        installerPath: filePath
      });
      return;
    }

    if (method === "POST" && pathname === "/api/roblox/register-protocol") {
      const detected = detectLocalInstallations();
      if (!detected.globalExecutablePath) {
        sendJson(res, 400, {
          error: "No local Global RobloxPlayerBeta.exe detected to bind protocol."
        });
        return;
      }
      await registerGlobalRobloxProtocol(detected.globalExecutablePath);
      sendJson(res, 200, {
        registered: true,
        executablePath: detected.globalExecutablePath
      });
      return;
    }

    if (method === "POST" && pathname === "/api/roblox/launch") {
      const body = await readJsonBody(req);
      const placeId = typeof body.placeId === "string" ? body.placeId.trim() : undefined;
      const result = launchGlobalRobloxClient({ placeId });
      sendJson(res, 200, result);
      return;
    }

    if (method === "GET" && pathname === "/api/catalog/search") {
      const keyword = parsedUrl.searchParams.get("keyword") || "";
      const items = await searchGlobalCatalog({
        keyword,
        limit: 10,
        proxyHost: this.store.getSettings().listenHost,
        proxyPort: this.splitProxy.getListenPort()
      });
      sendJson(res, 200, { items });
      return;
    }

    sendJson(res, 404, { error: `Unknown endpoint: ${method} ${pathname}` });
  }

  private renderDashboardHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Roblox Global Split-Tunnel & Bootstrapper</title>
  <style>
    :root {
      --bg-0: #060911;
      --bg-1: #0d1322;
      --panel: rgba(19, 27, 46, 0.82);
      --panel-hover: rgba(26, 37, 62, 0.92);
      --border: rgba(99, 132, 199, 0.22);
      --border-glow: rgba(56, 189, 248, 0.45);
      --text: #f1f5f9;
      --muted: #94a3b8;
      --cyan: #38bdf8;
      --indigo: #6366f1;
      --emerald: #10b981;
      --amber: #f59e0b;
      --rose: #f43f5e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
      background:
        radial-gradient(circle at 12% 10%, rgba(56, 189, 248, 0.14), transparent 36%),
        radial-gradient(circle at 88% 12%, rgba(99, 102, 241, 0.16), transparent 38%),
        linear-gradient(180deg, var(--bg-0) 0%, var(--bg-1) 100%);
      color: var(--text);
      padding: 22px 28px;
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: var(--panel);
      backdrop-filter: blur(16px);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 16px 22px;
      margin-bottom: 20px;
      box-shadow: 0 14px 34px rgba(0, 0, 0, 0.45);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .brand-logo {
      width: 42px;
      height: 42px;
      border-radius: 12px;
      background: linear-gradient(135deg, var(--cyan), var(--indigo));
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 900;
      font-size: 20px;
      color: #fff;
      box-shadow: 0 0 22px rgba(56, 189, 248, 0.45);
    }
    .brand-title h1 {
      margin: 0;
      font-size: 19px;
      font-weight: 800;
      letter-spacing: -0.3px;
      background: linear-gradient(90deg, #fff, #93c5fd);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .brand-title p {
      margin: 2px 0 0 0;
      font-size: 12px;
      color: var(--muted);
    }
    .status-cluster {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .pulse-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--emerald);
      box-shadow: 0 0 12px var(--emerald);
      display: inline-block;
      margin-right: 6px;
    }
    .badge {
      padding: 7px 14px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      background: rgba(16, 185, 129, 0.14);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.38);
      display: flex;
      align-items: center;
    }
    .badge.warn {
      background: rgba(245, 158, 11, 0.15);
      color: #fbbf24;
      border-color: rgba(245, 158, 11, 0.4);
    }
    .stats-strip {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 14px;
      margin-bottom: 20px;
    }
    .stat-tile {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px 18px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .stat-tile .label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.7px;
      color: var(--muted);
      font-weight: 600;
    }
    .stat-tile .val {
      font-size: 18px;
      font-weight: 800;
      color: var(--text);
    }
    .stat-tile .sub {
      font-size: 11px;
      color: var(--cyan);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
      gap: 18px;
    }
    .card {
      background: var(--panel);
      backdrop-filter: blur(12px);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
      transition: border-color 0.2s ease;
    }
    .card:hover {
      border-color: var(--border-glow);
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 14px;
    }
    .card h2 {
      margin: 0;
      font-size: 14px;
      font-weight: 700;
      color: var(--cyan);
      text-transform: uppercase;
      letter-spacing: 0.7px;
    }
    .row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 9px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      font-size: 13px;
    }
    .row:last-child { border-bottom: none; }
    .muted { color: var(--muted); }
    code {
      background: rgba(15, 23, 42, 0.85);
      border: 1px solid rgba(148, 163, 184, 0.2);
      padding: 3px 8px;
      border-radius: 6px;
      font-family: "Cascadia Code", Consolas, monospace;
      font-size: 12px;
      color: #bae6fd;
    }
    input[type="text"] {
      width: 100%;
      padding: 10px 12px;
      background: rgba(9, 13, 24, 0.9);
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 10px;
      outline: none;
    }
    input[type="text"]:focus {
      border-color: var(--cyan);
      box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2);
    }
    input[type="checkbox"] {
      width: 18px;
      height: 18px;
      accent-color: var(--cyan);
      cursor: pointer;
    }
    button {
      background: linear-gradient(135deg, var(--cyan), var(--indigo));
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 9px 15px;
      font-weight: 700;
      font-size: 12.5px;
      cursor: pointer;
      transition: transform 0.12s ease, opacity 0.15s ease;
      box-shadow: 0 4px 14px rgba(56, 189, 248, 0.28);
    }
    button:hover {
      opacity: 0.94;
      transform: translateY(-1px);
    }
    button.secondary {
      background: rgba(38, 50, 76, 0.9);
      color: var(--text);
      border: 1px solid var(--border);
      box-shadow: none;
    }
    button.emerald {
      background: linear-gradient(135deg, #10b981, #059669);
      box-shadow: 0 4px 14px rgba(16, 185, 129, 0.3);
    }
    button.danger {
      background: rgba(244, 63, 94, 0.15);
      color: #fda4af;
      border: 1px solid rgba(244, 63, 94, 0.35);
      box-shadow: none;
    }
    .btn-group {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 10px;
    }
    .lane-box {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      margin: 12px 0;
    }
    .lane {
      background: rgba(9, 13, 24, 0.75);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px;
      font-size: 11.5px;
    }
    .lane strong { display: block; margin-bottom: 3px; }
    .log-box {
      max-height: 250px;
      overflow-y: auto;
      font-family: "Cascadia Code", Consolas, monospace;
      font-size: 11.5px;
      background: rgba(6, 9, 17, 0.92);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px;
    }
    .log-line {
      padding: 5px 4px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
    .tag-tunnel { color: var(--cyan); font-weight: 700; }
    .tag-direct { color: var(--emerald); font-weight: 700; }
    .tag-block { color: var(--rose); font-weight: 700; }
    .catalog-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(195px, 1fr));
      gap: 14px;
      margin-top: 14px;
    }
    .catalog-item {
      background: rgba(9, 13, 24, 0.85);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
      font-size: 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      transition: transform 0.15s ease, border-color 0.15s ease;
    }
    .catalog-item:hover {
      transform: translateY(-3px);
      border-color: var(--cyan);
    }
    .catalog-thumb {
      width: 100%;
      aspect-ratio: 1 / 1;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.03);
      object-fit: contain;
    }
    .catalog-item a {
      color: var(--text);
      text-decoration: none;
      font-weight: 700;
      font-size: 13px;
      line-height: 1.3;
    }
    .catalog-item a:hover { color: var(--cyan); }
    .price-pill {
      display: inline-block;
      align-self: flex-start;
      padding: 3px 8px;
      border-radius: 6px;
      font-weight: 700;
      font-size: 11px;
      background: rgba(16, 185, 129, 0.16);
      color: #34d399;
    }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="brand">
      <div class="brand-logo">R</div>
      <div class="brand-title">
        <h1>ROBLOX GLOBAL SPLIT-TUNNEL & BOOTSTRAPPER</h1>
        <p>Zero-Lag Direct ISP Gameplay + Automatic Non-VN Global Catalog & Account Protection</p>
      </div>
    </div>
    <div class="status-cluster">
      <div id="statusBadge" class="badge"><span class="pulse-dot"></span>Wired by Default</div>
      <button class="emerald" onclick="launchGlobal()">Launch Global Roblox</button>
    </div>
  </div>

  <div class="stats-strip">
    <div class="stat-tile">
      <span class="label">Split-Proxy & PAC</span>
      <span class="val" id="proxyEndpoint">127.0.0.1:7899</span>
      <span class="sub" id="pacStateSub">Windows System PAC Wired</span>
    </div>
    <div class="stat-tile">
      <span class="label">*.roblox.com API Exit</span>
      <span class="val" id="statTunnelCount">0 reqs</span>
      <span class="sub" id="activeUpstreamLabel">Cloudflare WARP Global</span>
    </div>
    <div class="stat-tile">
      <span class="label">Direct ISP Gameplay / CDN</span>
      <span class="val" id="statDirectCount">0 reqs</span>
      <span class="sub">128.116.0.0/17 UDP Raw Ping</span>
    </div>
    <div class="stat-tile">
      <span class="label">VNG Redirect Shield</span>
      <span class="val" id="statBlockCount">0 blocked</span>
      <span class="sub">vnggames.com & zing.vn sinkholed</span>
    </div>
  </div>

  <div class="grid">
    <!-- 1. Split-Tunnel Routing Engine -->
    <div class="card">
      <div class="card-header">
        <h2>1. Default-Wired Split-Tunnel Architecture</h2>
        <code id="pacUrl">http://127.0.0.1:7899/proxy.pac</code>
      </div>
      <div class="lane-box">
        <div class="lane">
          <strong style="color:var(--cyan);">GLOBAL TUNNEL</strong>
          <span class="muted">*.roblox.com, auth, catalog, gamejoin</span>
        </div>
        <div class="lane">
          <strong style="color:var(--emerald);">DIRECT RAW ISP</strong>
          <span class="muted">UDP 49152-65535 & *.rbxcdn.com</span>
        </div>
        <div class="lane">
          <strong style="color:var(--rose);">VNG SINKHOLE</strong>
          <span class="muted">Blocks vnggames.com auto-migration</span>
        </div>
      </div>
      <div class="row">
        <span>Route <code>*.rbxcdn.com</code> Direct (Full Local ISP Download Speed)</span>
        <input type="checkbox" id="chkCdnDirect" onchange="saveToggles()" />
      </div>
      <div class="row">
        <span>Block VNG Redirect & Telemetry Hosts (<code>vnggames.com</code>)</span>
        <input type="checkbox" id="chkBlockVng" onchange="saveToggles()" />
      </div>
      <div class="row">
        <span>Wire Windows System PAC (<code>AutoConfigURL</code>) by Default</span>
        <input type="checkbox" id="chkWinPac" onchange="saveToggles()" />
      </div>
      <div class="btn-group">
        <button onclick="runRegionCheck()">Verify Live Exit IP & VNG Protection</button>
        <button class="secondary" onclick="exportSingBox()">Export Sing-Box JSON</button>
      </div>
      <div id="regionReportBox" style="margin-top:12px;font-size:12.5px;line-height:1.5;color:var(--muted);"></div>
    </div>

    <!-- 2. Non-VN Upstream Profiles -->
    <div class="card">
      <div class="card-header">
        <h2>2. Upstream Global Tunnel Profiles</h2>
        <button class="secondary" onclick="provisionWarp()" id="btnProvisionWarp">Auto-Wire Free Cloudflare WARP</button>
      </div>
      <label class="muted" style="font-size:11.5px;display:block;margin-bottom:6px;">
        Add custom SOCKS5 / HTTP / WireGuard / VLESS / Shadowsocks URI (or use built-in auto-wired WARP):
      </label>
      <div style="display:flex;gap:8px;">
        <input type="text" id="tunnelUriInput" title="Enter tunnel URI" style="margin-bottom:0;" />
        <button onclick="addUpstreamUri()" style="white-space:nowrap;">Add Tunnel</button>
      </div>
      <div id="upstreamList" style="margin-top:12px;"></div>
    </div>

    <!-- 3. Global Roblox Client Bootstrapper -->
    <div class="card">
      <div class="card-header">
        <h2>3. Official Global Roblox Bootstrapper</h2>
        <span class="muted" style="font-size:11px;">Direct from setup.rbxcdn.com</span>
      </div>
      <div class="row">
        <span class="muted">Latest Global WindowsPlayer</span>
        <code id="liveGlobalVer">Checking...</code>
      </div>
      <div class="row">
        <span class="muted">Local Global Client Installed</span>
        <code id="localGlobalVer">Checking...</code>
      </div>
      <div class="row">
        <span class="muted">VNG Client Conflict Scan</span>
        <span id="vngConflictStatus">Checking...</span>
      </div>
      <div style="margin-top:12px;">
        <label class="muted" style="font-size:11.5px;display:block;margin-bottom:6px;">Optional Place ID (leave blank to open Global Roblox Desktop App)</label>
        <input type="text" id="placeIdInput" title="Optional Place ID" />
        <div class="btn-group">
          <button class="emerald" onclick="launchGlobal()">Launch Global Client</button>
          <button onclick="downloadGlobalInstaller()">Download Official Global Installer (.exe)</button>
          <button class="secondary" onclick="bindGlobalProtocol()">Bind roblox-player: Protocol</button>
        </div>
      </div>
      <div id="bootstrapStatus" style="margin-top:10px;font-size:12px;color:var(--cyan);"></div>
    </div>

    <!-- 4. Live Split-Tunnel Route Telemetry -->
    <div class="card">
      <div class="card-header">
        <h2>4. Real-Time Split-Tunnel Packet Decisions</h2>
        <span class="muted" style="font-size:11px;">Live Stream</span>
      </div>
      <div class="log-box" id="telemetryLogs">Loading traffic events...</div>
    </div>
  </div>

  <!-- 5. Global Catalog Explorer -->
  <div class="card" style="margin-top:18px;">
    <div class="card-header">
      <h2>5. Live Global Catalog Explorer (Routed via Split-Tunnel)</h2>
      <span class="muted" style="font-size:12px;">Queries catalog.roblox.com & thumbnails.roblox.com</span>
    </div>
    <label class="muted" style="font-size:11.5px;display:block;margin-bottom:6px;">Search Global Catalog Keyword (e.g. Valkyrie, Fedora, Korblox, Dominus, Hair)</label>
    <div style="display:flex;gap:10px;">
      <input type="text" id="catalogKeyword" value="Valkyrie" title="Catalog keyword" style="margin-bottom:0;" />
      <button onclick="searchCatalog()" style="white-space:nowrap;">Search Global Catalog</button>
    </div>
    <div class="catalog-grid" id="catalogResults"></div>
  </div>

  <script>
    async function refreshState() {
      const res = await fetch('/api/state');
      const data = await res.json();
      document.getElementById('proxyEndpoint').textContent = data.settings.listenHost + ':' + data.proxyListenPort;
      document.getElementById('pacUrl').textContent = data.pacUrl;
      document.getElementById('chkCdnDirect').checked = data.settings.routeRbxCdnDirect;
      document.getElementById('chkBlockVng').checked = data.settings.blockVngRedirects;
      document.getElementById('chkWinPac').checked = Boolean(data.windowsAutoConfigUrl);
      document.getElementById('pacStateSub').textContent = data.windowsAutoConfigUrl
        ? 'Windows System PAC Wired Automatically'
        : 'Manual / Local Proxy Mode';

      const active = data.activeUpstream;
      const badge = document.getElementById('statusBadge');
      if (active) {
        const sbSuffix = data.singBoxRunning ? ' (Sing-Box Core Active)' : '';
        document.getElementById('activeUpstreamLabel').textContent = active.name + ' [' + active.protocol.toUpperCase() + ']' + sbSuffix;
        badge.innerHTML = '<span class="pulse-dot"></span>Wired: *.roblox.com -> ' + active.name;
        badge.className = 'badge';
      } else {
        document.getElementById('activeUpstreamLabel').textContent = 'No Upstream Active';
        badge.textContent = 'Direct Mode (Click Auto-Wire WARP)';
        badge.className = 'badge warn';
      }

      const events = data.recentEvents || [];
      const tunnelCount = events.filter(e => e.decision === 'GLOBAL_TUNNEL').length;
      const directCount = events.filter(e => e.decision === 'DIRECT_ISP').length;
      const blockCount = events.filter(e => e.decision === 'BLOCK_VNG_TELEMETRY').length;
      document.getElementById('statTunnelCount').textContent = tunnelCount + ' tunneled';
      document.getElementById('statDirectCount').textContent = directCount + ' direct';
      document.getElementById('statBlockCount').textContent = blockCount + ' blocked';

      const ul = document.getElementById('upstreamList');
      ul.innerHTML = '';
      for (const u of data.settings.upstreams) {
        const div = document.createElement('div');
        div.className = 'row';
        const isCurrent = data.settings.activeUpstreamId === u.id;
        div.innerHTML =
          '<span><strong>' + u.name + '</strong> <span class="muted">(' + u.protocol + '://' + u.server + ':' + u.serverPort + ')</span></span>' +
          '<div class="btn-group" style="margin-top:0;">' +
          (isCurrent ? '<span class="badge">Active Default</span>' : '<button class="secondary" onclick="selectUpstream(\\'' + u.id + '\\')">Activate</button>') +
          '<button class="danger" onclick="deleteUpstream(\\'' + u.id + '\\')">Remove</button>' +
          '</div>';
        ul.appendChild(div);
      }

      const inst = data.installations;
      document.getElementById('localGlobalVer').textContent = inst.globalInstalled
        ? inst.installedVersionUpload
        : 'Not Installed Yet (Click Download Official Global Installer)';
      document.getElementById('vngConflictStatus').textContent = inst.vngDetected
        ? 'WARNING: Found VNG folder (' + inst.vngPaths.join(', ') + ')'
        : 'Clean (Zero VNG Client Traces)';

      const logBox = document.getElementById('telemetryLogs');
      if (events.length === 0) {
        logBox.innerHTML = '<div class="muted">Ready. Routing telemetry will stream here automatically.</div>';
      } else {
        logBox.innerHTML = events.map(e => {
          const cls = e.decision === 'GLOBAL_TUNNEL' ? 'tag-tunnel' : (e.decision === 'BLOCK_VNG_TELEMETRY' ? 'tag-block' : 'tag-direct');
          return '<div class="log-line"><span><span class="' + cls + '">[' + e.decision + ']</span> ' +
            e.hostname + ':' + e.port + '</span><span class="muted">' + e.reason + '</span></div>';
        }).join('');
      }
    }

    async function checkRobloxVersion() {
      try {
        const res = await fetch('/api/roblox/version');
        const data = await res.json();
        if (data.liveVersion) {
          document.getElementById('liveGlobalVer').textContent =
            data.liveVersion.version + ' (' + data.liveVersion.clientVersionUpload + ')';
        }
      } catch (e) {
        document.getElementById('liveGlobalVer').textContent = 'Offline / Error';
      }
    }

    async function saveToggles() {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          routeRbxCdnDirect: document.getElementById('chkCdnDirect').checked,
          blockVngRedirects: document.getElementById('chkBlockVng').checked,
          autoConfigureWindowsPac: document.getElementById('chkWinPac').checked
        })
      });
      await refreshState();
    }

    async function provisionWarp() {
      const btn = document.getElementById('btnProvisionWarp');
      btn.textContent = 'Provisioning WARP + Sing-Box...';
      const res = await fetch('/api/upstreams/provision-warp', { method: 'POST' });
      const data = await res.json();
      btn.textContent = 'Auto-Wire Free Cloudflare WARP';
      if (data.error) {
        alert(data.error);
      } else {
        await refreshState();
        await runRegionCheck();
      }
    }

    async function addUpstreamUri() {
      const uri = document.getElementById('tunnelUriInput').value.trim();
      if (!uri) return;
      const res = await fetch('/api/upstreams/uri', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri })
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
      } else {
        document.getElementById('tunnelUriInput').value = '';
        await refreshState();
      }
    }

    async function selectUpstream(id) {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeUpstreamId: id })
      });
      await refreshState();
    }

    async function deleteUpstream(id) {
      await fetch('/api/upstreams/' + encodeURIComponent(id), { method: 'DELETE' });
      await refreshState();
    }

    async function runRegionCheck() {
      const box = document.getElementById('regionReportBox');
      box.textContent = 'Probing Direct ISP IP vs Split-Tunnel *.roblox.com Exit...';
      const res = await fetch('/api/region-check');
      const r = await res.json();
      box.innerHTML =
        '<div><strong>Direct Gameplay ISP:</strong> <code>' + r.directIp + '</code> (' + r.directCountryCode + ' - ' + r.directIsp + ')</div>' +
        '<div style="margin-top:4px;"><strong>*.roblox.com Tunnel Exit:</strong> <code>' + (r.proxiedIp || 'Direct') + '</code> (' + r.proxiedCountryCode + ')</div>' +
        '<div style="margin-top:6px;font-weight:600;color:' + (r.vngRiskLevel === 'VNG_LOCK_RISK' ? 'var(--rose)' : 'var(--emerald)') + ';">' + r.summary + '</div>';
      await refreshState();
    }

    async function exportSingBox() {
      const res = await fetch('/api/singbox-config');
      const data = await res.json();
      if (data.error) {
        alert(data.error);
        return;
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'sing-box-roblox-split.json';
      a.click();
    }

    async function launchGlobal() {
      const status = document.getElementById('bootstrapStatus');
      const placeId = document.getElementById('placeIdInput').value.trim();
      status.textContent = 'Launching Global RobloxPlayerBeta.exe...';
      const res = await fetch('/api/roblox/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ placeId })
      });
      const data = await res.json();
      status.textContent = data.error ? ('Notice: ' + data.error) : ('Launched Global Roblox (PID ' + data.pid + ')');
    }

    async function downloadGlobalInstaller() {
      const status = document.getElementById('bootstrapStatus');
      status.textContent = 'Downloading official Global Roblox bootstrapper directly from setup.rbxcdn.com...';
      const res = await fetch('/api/roblox/download-installer', { method: 'POST' });
      const data = await res.json();
      status.textContent = data.error
        ? ('Error: ' + data.error)
        : ('Downloaded Official Global Installer: ' + data.installerPath);
    }

    async function bindGlobalProtocol() {
      const status = document.getElementById('bootstrapStatus');
      const res = await fetch('/api/roblox/register-protocol', { method: 'POST' });
      const data = await res.json();
      status.textContent = data.error
        ? ('Notice: ' + data.error)
        : ('Bound roblox-player: URI protocol to ' + data.executablePath);
    }

    async function searchCatalog() {
      const kw = document.getElementById('catalogKeyword').value.trim();
      const grid = document.getElementById('catalogResults');
      grid.innerHTML = '<div class="muted">Querying catalog.roblox.com & thumbnails.roblox.com via Split-Tunnel...</div>';
      const res = await fetch('/api/catalog/search?keyword=' + encodeURIComponent(kw));
      const data = await res.json();
      if (data.error) {
        grid.innerHTML = '<div style="color:var(--rose);">' + data.error + '</div>';
        return;
      }
      grid.innerHTML = (data.items || []).map(item =>
        '<div class="catalog-item">' +
          (item.thumbnailUrl ? '<img class="catalog-thumb" src="' + item.thumbnailUrl + '" alt="' + item.name + '" />' : '') +
          '<a href="https://www.roblox.com/catalog/' + item.id + '" target="_blank">' + item.name + '</a>' +
          '<div class="muted">ID: ' + item.id + ' • ' + item.creatorName + '</div>' +
          '<span class="price-pill">' +
            (item.price !== undefined ? (item.price + ' Robux') : (item.priceStatus || 'Offsale')) +
          '</span>' +
        '</div>'
      ).join('');
      await refreshState();
    }

    refreshState();
    checkRobloxVersion();
    runRegionCheck();
    searchCatalog();
    setInterval(refreshState, 3500);
  </script>
</body>
</html>`;
  }
}

/**
 * Opens the Dashboard URL in a native-style Windows App Window using Microsoft Edge or Chrome (--app mode).
 */
export function openDesktopAppWindow(url: string): void {
  if (process.platform !== "win32") {
    return;
  }
  const edgeCandidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
  ];
  for (const exe of edgeCandidates) {
    if (fs.existsSync(exe)) {
      const child = spawn(exe, [`--app=${url}`, "--window-size=1220,820"], {
        detached: true,
        stdio: "ignore"
      });
      child.unref();
      return;
    }
  }
  const child = spawn("cmd.exe", ["/c", "start", "", url], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}
