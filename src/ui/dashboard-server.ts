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
      --bg-canvas: #F5F5F3;
      --bg-surface: #FFFFFF;
      --bg-subtle: #FAFAFA;
      --ink: #0A0A0A;
      --ink-secondary: #525252;
      --ink-muted: #737373;
      --line: #D4D4D0;
      --line-strong: #0A0A0A;
      --ag-blue: #0052FF;
      --ag-green: #007A33;
      --ag-red: #C81E1E;
      --ag-amber: #B45309;
      --mono: "JetBrains Mono", "Cascadia Code", "Consolas", monospace;
      --sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * {
      box-sizing: border-box;
      border-radius: 0 !important;
    }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: var(--sans);
      background-color: var(--bg-canvas);
      background-image:
        linear-gradient(to right, rgba(0, 0, 0, 0.035) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(0, 0, 0, 0.035) 1px, transparent 1px);
      background-size: 24px 24px;
      color: var(--ink);
      padding: 0;
      -webkit-font-smoothing: antialiased;
    }
    .shell {
      max-width: 1440px;
      margin: 0 auto;
      border-left: 1px solid var(--line-strong);
      border-right: 1px solid var(--line-strong);
      background: var(--bg-surface);
      min-height: 100vh;
    }
    /* Top Architectural Bar */
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: stretch;
      border-bottom: 2px solid var(--line-strong);
      background: var(--bg-surface);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 16px 24px;
      border-right: 1px solid var(--line);
    }
    .brand-mark {
      width: 34px;
      height: 34px;
      background: var(--ink);
      color: var(--bg-surface);
      font-family: var(--mono);
      font-weight: 700;
      font-size: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      letter-spacing: -0.5px;
    }
    .brand-title h1 {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      color: var(--ink);
    }
    .brand-title p {
      margin: 3px 0 0 0;
      font-family: var(--mono);
      font-size: 11px;
      color: var(--ink-secondary);
    }
    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 24px;
    }
    .status-tag {
      font-family: var(--mono);
      font-size: 11.5px;
      font-weight: 600;
      padding: 8px 12px;
      border: 1px solid var(--line-strong);
      background: var(--bg-subtle);
      color: var(--ink);
      text-transform: uppercase;
      letter-spacing: 0.4px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .status-square {
      width: 8px;
      height: 8px;
      background: var(--ag-green);
      display: inline-block;
    }
    .status-tag.warn .status-square {
      background: var(--ag-amber);
    }

    /* 4-Column Metric Matrix */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      border-bottom: 1px solid var(--line-strong);
      background: var(--bg-surface);
    }
    .metric-cell {
      padding: 16px 24px;
      border-right: 1px solid var(--line);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .metric-cell:last-child {
      border-right: none;
    }
    .metric-cell .idx {
      font-family: var(--mono);
      font-size: 10px;
      color: var(--ink-muted);
      text-transform: uppercase;
      letter-spacing: 0.8px;
    }
    .metric-cell .val {
      font-family: var(--mono);
      font-size: 20px;
      font-weight: 700;
      color: var(--ink);
      letter-spacing: -0.5px;
    }
    .metric-cell .sub {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--ag-blue);
    }

    /* Main 2x2 Architectural Grid */
    .workspace-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      border-bottom: 1px solid var(--line-strong);
    }
    .panel {
      padding: 22px 24px;
      border-right: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      background: var(--bg-surface);
    }
    .panel:nth-child(2n) {
      border-right: none;
    }
    .panel-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding-bottom: 12px;
      margin-bottom: 14px;
      border-bottom: 1px solid var(--line-strong);
    }
    .panel-head h2 {
      margin: 0;
      font-family: var(--mono);
      font-size: 12.5px;
      font-weight: 700;
      color: var(--ink);
      text-transform: uppercase;
      letter-spacing: 0.6px;
    }
    .panel-head .meta {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--ink-muted);
    }

    /* Schematic Lanes */
    .schematic-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      border: 1px solid var(--line-strong);
      margin-bottom: 14px;
      background: var(--bg-subtle);
    }
    .schematic-col {
      padding: 10px 12px;
      border-right: 1px solid var(--line);
      font-size: 11.5px;
    }
    .schematic-col:last-child {
      border-right: none;
    }
    .schematic-col strong {
      display: block;
      font-family: var(--mono);
      font-size: 11px;
      margin-bottom: 4px;
      text-transform: uppercase;
    }

    /* Rows & Controls */
    .row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 9px 0;
      border-bottom: 1px solid var(--line);
      font-size: 13px;
    }
    .row:last-child {
      border-bottom: none;
    }
    .muted {
      color: var(--ink-secondary);
    }
    code {
      font-family: var(--mono);
      font-size: 11.5px;
      background: var(--bg-canvas);
      border: 1px solid var(--line);
      padding: 2px 6px;
      color: var(--ink);
    }
    label.field-label {
      font-family: var(--mono);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: var(--ink-secondary);
      display: block;
      margin-bottom: 6px;
    }
    input[type="text"] {
      width: 100%;
      padding: 9px 11px;
      background: var(--bg-surface);
      border: 1px solid var(--line-strong);
      color: var(--ink);
      font-family: var(--mono);
      font-size: 12.5px;
      outline: none;
      margin-bottom: 10px;
    }
    input[type="text"]:focus {
      border-color: var(--ag-blue);
      background: var(--bg-subtle);
    }
    input[type="checkbox"] {
      width: 16px;
      height: 16px;
      accent-color: var(--ink);
      cursor: pointer;
    }
    button {
      font-family: var(--mono);
      font-size: 11.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 9px 14px;
      background: var(--ink);
      color: var(--bg-surface);
      border: 1px solid var(--ink);
      cursor: pointer;
      transition: background 0.1s ease, color 0.1s ease;
    }
    button:hover {
      background: var(--bg-surface);
      color: var(--ink);
    }
    button.secondary {
      background: var(--bg-surface);
      color: var(--ink);
      border: 1px solid var(--line-strong);
    }
    button.secondary:hover {
      background: var(--ink);
      color: var(--bg-surface);
    }
    button.primary-blue {
      background: var(--ag-blue);
      border-color: var(--ag-blue);
      color: #FFFFFF;
    }
    button.primary-blue:hover {
      background: var(--ink);
      border-color: var(--ink);
      color: #FFFFFF;
    }
    button.danger {
      background: var(--bg-surface);
      color: var(--ag-red);
      border: 1px solid var(--ag-red);
    }
    button.danger:hover {
      background: var(--ag-red);
      color: #FFFFFF;
    }
    .btn-group {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 12px;
    }

    /* Telemetry Log Table */
    .log-box {
      height: 255px;
      overflow-y: auto;
      font-family: var(--mono);
      font-size: 11.5px;
      background: var(--bg-subtle);
      border: 1px solid var(--line-strong);
      padding: 8px 10px;
    }
    .log-line {
      padding: 5px 0;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }
    .tag-tunnel { color: var(--ag-blue); font-weight: 700; }
    .tag-direct { color: var(--ag-green); font-weight: 700; }
    .tag-block { color: var(--ag-red); font-weight: 700; }

    /* Catalog Section */
    .catalog-section {
      padding: 22px 24px;
      background: var(--bg-surface);
    }
    .catalog-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      border-top: 1px solid var(--line-strong);
      border-left: 1px solid var(--line-strong);
      margin-top: 16px;
    }
    .catalog-item {
      background: var(--bg-surface);
      border-right: 1px solid var(--line-strong);
      border-bottom: 1px solid var(--line-strong);
      padding: 14px;
      font-size: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .catalog-item:hover {
      background: var(--bg-subtle);
    }
    .catalog-thumb {
      width: 100%;
      aspect-ratio: 1 / 1;
      background: var(--bg-canvas);
      border: 1px solid var(--line);
      object-fit: contain;
    }
    .catalog-item a {
      color: var(--ink);
      text-decoration: none;
      font-weight: 700;
      font-size: 13px;
      line-height: 1.3;
    }
    .catalog-item a:hover {
      color: var(--ag-blue);
      text-decoration: underline;
    }
    .price-tag {
      font-family: var(--mono);
      display: inline-block;
      align-self: flex-start;
      padding: 3px 7px;
      font-weight: 700;
      font-size: 11px;
      border: 1px solid var(--ink);
      background: var(--bg-canvas);
      color: var(--ink);
    }
    .report-panel {
      margin-top: 12px;
      padding: 10px 12px;
      border: 1px solid var(--line-strong);
      background: var(--bg-subtle);
      font-family: var(--mono);
      font-size: 11.5px;
      line-height: 1.55;
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="topbar">
      <div class="brand">
        <div class="brand-mark">AG</div>
        <div class="brand-title">
          <h1>ROBLOX GLOBAL SPLIT-TUNNEL // CONTROL MATRIX</h1>
          <p>ANTIGRAVITY ROUTING ENGINE — *.ROBLOX.COM TUNNELED / UDP GAMEPLAY DIRECT ISP</p>
        </div>
      </div>
      <div class="topbar-actions">
        <div id="statusBadge" class="status-tag"><span class="status-square"></span>WIRED BY DEFAULT</div>
        <button class="primary-blue" onclick="launchGlobal()">LAUNCH GLOBAL ROBLOX</button>
      </div>
    </div>

    <div class="metrics-grid">
      <div class="metric-cell">
        <span class="idx">SYS.01 // LOCAL SPLIT PROXY</span>
        <span class="val" id="proxyEndpoint">127.0.0.1:7899</span>
        <span class="sub" id="pacStateSub">WINDOWS PAC AUTO-WIRED</span>
      </div>
      <div class="metric-cell">
        <span class="idx">SYS.02 // *.ROBLOX.COM API ROUTE</span>
        <span class="val" id="statTunnelCount">0 PKTS</span>
        <span class="sub" id="activeUpstreamLabel">CLOUDFLARE WARP GLOBAL</span>
      </div>
      <div class="metric-cell">
        <span class="idx">SYS.03 // DIRECT ISP GAMEPLAY</span>
        <span class="val" id="statDirectCount">0 PKTS</span>
        <span class="sub">128.116.0.0/17 UDP RAW PING</span>
      </div>
      <div class="metric-cell">
        <span class="idx">SYS.04 // VNG SINKHOLE GUARD</span>
        <span class="val" id="statBlockCount">0 BLOCKED</span>
        <span class="sub">VNGGAMES.COM & ZING.VN</span>
      </div>
    </div>

    <div class="workspace-grid">
      <!-- 01 // SPLIT-TUNNEL ARCHITECTURE -->
      <div class="panel">
        <div class="panel-head">
          <h2>01 // SPLIT-TUNNEL ROUTING MATRIX</h2>
          <code id="pacUrl">http://127.0.0.1:7899/proxy.pac</code>
        </div>
        <div class="schematic-grid">
          <div class="schematic-col">
            <strong style="color:var(--ag-blue);">■ LANE A: GLOBAL TUNNEL</strong>
            <span class="muted">*.roblox.com, auth, catalog, gamejoin</span>
          </div>
          <div class="schematic-col">
            <strong style="color:var(--ag-green);">■ LANE B: DIRECT ISP</strong>
            <span class="muted">UDP 49152-65535 & *.rbxcdn.com</span>
          </div>
          <div class="schematic-col">
            <strong style="color:var(--ag-red);">■ LANE C: VNG SINKHOLE</strong>
            <span class="muted">Blocks vnggames.com migration</span>
          </div>
        </div>
        <div class="row">
          <span>Route <code>*.rbxcdn.com</code> Direct (Unthrottled Local ISP Asset CDN)</span>
          <input type="checkbox" id="chkCdnDirect" onchange="saveToggles()" />
        </div>
        <div class="row">
          <span>Block VNG Redirect & Telemetry Endpoints (<code>vnggames.com</code>)</span>
          <input type="checkbox" id="chkBlockVng" onchange="saveToggles()" />
        </div>
        <div class="row">
          <span>Bind Windows System PAC (<code>AutoConfigURL</code>) Automatically</span>
          <input type="checkbox" id="chkWinPac" onchange="saveToggles()" />
        </div>
        <div class="btn-group">
          <button onclick="runRegionCheck()">VERIFY EXIT IP & VNG RISK</button>
          <button class="secondary" onclick="exportSingBox()">EXPORT SING-BOX JSON</button>
        </div>
        <div id="regionReportBox" class="report-panel">Probing network topology...</div>
      </div>

      <!-- 02 // UPSTREAM TUNNEL NODES -->
      <div class="panel">
        <div class="panel-head">
          <h2>02 // UPSTREAM NON-VN NODES</h2>
          <button class="secondary" onclick="provisionWarp()" id="btnProvisionWarp">AUTO-WIRE CLOUDFLARE WARP</button>
        </div>
        <label class="field-label">ADD TUNNEL URI (SOCKS5 / HTTP / WIREGUARD / VLESS / SHADOWSOCKS)</label>
        <div style="display:flex;gap:8px;">
          <input type="text" id="tunnelUriInput" title="Enter tunnel URI" style="margin-bottom:0;" />
          <button onclick="addUpstreamUri()" style="white-space:nowrap;">ADD NODE</button>
        </div>
        <div id="upstreamList" style="margin-top:14px;"></div>
      </div>

      <!-- 03 // GLOBAL ROBLOX BOOTSTRAPPER -->
      <div class="panel">
        <div class="panel-head">
          <h2>03 // GLOBAL ROBLOX CLIENT BOOTSTRAPPER</h2>
          <span class="meta">SOURCE: SETUP.RBXCDN.COM</span>
        </div>
        <div class="row">
          <span class="muted">Live Global WindowsPlayer Build</span>
          <code id="liveGlobalVer">Checking...</code>
        </div>
        <div class="row">
          <span class="muted">Local Global Binary Status</span>
          <code id="localGlobalVer">Checking...</code>
        </div>
        <div class="row">
          <span class="muted">VNG Package Conflict Scan</span>
          <code id="vngConflictStatus">Checking...</code>
        </div>
        <div style="margin-top:14px;">
          <label class="field-label">OPTIONAL PLACE ID (BLANK = LAUNCH GLOBAL DESKTOP APP)</label>
          <input type="text" id="placeIdInput" title="Optional Place ID" />
          <div class="btn-group">
            <button class="primary-blue" onclick="launchGlobal()">LAUNCH GLOBAL CLIENT</button>
            <button onclick="downloadGlobalInstaller()">FETCH OFFICIAL GLOBAL INSTALLER (.EXE)</button>
            <button class="secondary" onclick="bindGlobalProtocol()">LOCK ROBLOX-PLAYER: URI</button>
          </div>
        </div>
        <div id="bootstrapStatus" style="margin-top:10px;font-family:var(--mono);font-size:11.5px;color:var(--ag-blue);"></div>
      </div>

      <!-- 04 // REAL-TIME PACKET TELEMETRY -->
      <div class="panel">
        <div class="panel-head">
          <h2>04 // PACKET ROUTING TELEMETRY</h2>
          <span class="meta">LIVE STREAM</span>
        </div>
        <div class="log-box" id="telemetryLogs">Initializing packet telemetry stream...</div>
      </div>
    </div>

    <!-- 05 // GLOBAL CATALOG EXPLORER -->
    <div class="catalog-section">
      <div class="panel-head">
        <h2>05 // GLOBAL CATALOG INDEX (ROUTED VIA SPLIT-TUNNEL)</h2>
        <span class="meta">ENDPOINT: CATALOG.ROBLOX.COM</span>
      </div>
      <label class="field-label">SEARCH GLOBAL CATALOG KEYWORD (VALKYRIE, FEDORA, DOMINUS, KORBLOX)</label>
      <div style="display:flex;gap:8px;max-width:640px;">
        <input type="text" id="catalogKeyword" value="Valkyrie" title="Catalog keyword" style="margin-bottom:0;" />
        <button onclick="searchCatalog()" style="white-space:nowrap;">QUERY CATALOG</button>
      </div>
      <div class="catalog-grid" id="catalogResults"></div>
    </div>
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
        ? 'WINDOWS PAC AUTO-WIRED'
        : 'LOCAL PROXY MODE';

      const active = data.activeUpstream;
      const badge = document.getElementById('statusBadge');
      if (active) {
        const sbSuffix = data.singBoxRunning ? ' // SING-BOX ACTIVE' : '';
        document.getElementById('activeUpstreamLabel').textContent = active.name.toUpperCase() + ' [' + active.protocol.toUpperCase() + ']' + sbSuffix;
        badge.innerHTML = '<span class="status-square"></span>WIRED: ' + active.name.toUpperCase();
        badge.className = 'status-tag';
      } else {
        document.getElementById('activeUpstreamLabel').textContent = 'NO UPSTREAM CONFIGURED';
        badge.innerHTML = '<span class="status-square"></span>DIRECT FALLBACK';
        badge.className = 'status-tag warn';
      }

      const events = data.recentEvents || [];
      const tunnelCount = events.filter(e => e.decision === 'GLOBAL_TUNNEL').length;
      const directCount = events.filter(e => e.decision === 'DIRECT_ISP').length;
      const blockCount = events.filter(e => e.decision === 'BLOCK_VNG_TELEMETRY').length;
      document.getElementById('statTunnelCount').textContent = tunnelCount + ' TUNNELED';
      document.getElementById('statDirectCount').textContent = directCount + ' DIRECT';
      document.getElementById('statBlockCount').textContent = blockCount + ' BLOCKED';

      const ul = document.getElementById('upstreamList');
      ul.innerHTML = '';
      for (const u of data.settings.upstreams) {
        const div = document.createElement('div');
        div.className = 'row';
        const isCurrent = data.settings.activeUpstreamId === u.id;
        div.innerHTML =
          '<span><strong style="font-family:var(--mono);font-size:12px;">' + u.name + '</strong> <code>' + u.protocol + '://' + u.server + ':' + u.serverPort + '</code></span>' +
          '<div class="btn-group" style="margin-top:0;">' +
          (isCurrent ? '<span class="status-tag"><span class="status-square"></span>ACTIVE</span>' : '<button class="secondary" onclick="selectUpstream(\\'' + u.id + '\\')">ACTIVATE</button>') +
          '<button class="danger" onclick="deleteUpstream(\\'' + u.id + '\\')">DELETE</button>' +
          '</div>';
        ul.appendChild(div);
      }

      const inst = data.installations;
      document.getElementById('localGlobalVer').textContent = inst.globalInstalled
        ? inst.installedVersionUpload
        : 'NOT INSTALLED (CLICK FETCH OFFICIAL GLOBAL INSTALLER)';
      document.getElementById('vngConflictStatus').textContent = inst.vngDetected
        ? 'CONFLICT: ' + inst.vngPaths.join(', ')
        : 'CLEAN (0 VNG TRACES)';

      const logBox = document.getElementById('telemetryLogs');
      if (events.length === 0) {
        logBox.innerHTML = '<div class="muted">Awaiting packet traffic...</div>';
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
        document.getElementById('liveGlobalVer').textContent = 'OFFLINE';
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
      btn.textContent = 'PROVISIONING WARP...';
      const res = await fetch('/api/upstreams/provision-warp', { method: 'POST' });
      const data = await res.json();
      btn.textContent = 'AUTO-WIRE CLOUDFLARE WARP';
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
      box.textContent = 'PROBING DIRECT ISP VS SPLIT-TUNNEL EXIT...';
      const res = await fetch('/api/region-check');
      const r = await res.json();
      box.innerHTML =
        '<div><strong>DIRECT GAMEPLAY ISP :</strong> ' + r.directIp + ' (' + r.directCountryCode + ' // ' + r.directIsp + ')</div>' +
        '<div><strong>*.ROBLOX.COM EXIT   :</strong> ' + (r.proxiedIp || 'Direct') + ' (' + r.proxiedCountryCode + ')</div>' +
        '<div style="margin-top:6px;font-weight:700;color:' + (r.vngRiskLevel === 'VNG_LOCK_RISK' ? 'var(--ag-red)' : 'var(--ag-green)') + ';">' + r.summary + '</div>';
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
      status.textContent = 'EXECUTING GLOBAL ROBLOXPLAYERBETA.EXE...';
      const res = await fetch('/api/roblox/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ placeId })
      });
      const data = await res.json();
      status.textContent = data.error ? ('STATUS: ' + data.error) : ('LAUNCHED PID ' + data.pid);
    }

    async function downloadGlobalInstaller() {
      const status = document.getElementById('bootstrapStatus');
      status.textContent = 'DOWNLOADING GLOBAL INSTALLER FROM SETUP.RBXCDN.COM...';
      const res = await fetch('/api/roblox/download-installer', { method: 'POST' });
      const data = await res.json();
      status.textContent = data.error
        ? ('ERROR: ' + data.error)
        : ('SAVED: ' + data.installerPath);
    }

    async function bindGlobalProtocol() {
      const status = document.getElementById('bootstrapStatus');
      const res = await fetch('/api/roblox/register-protocol', { method: 'POST' });
      const data = await res.json();
      status.textContent = data.error
        ? ('STATUS: ' + data.error)
        : ('LOCKED ROBLOX-PLAYER: -> ' + data.executablePath);
    }

    async function searchCatalog() {
      const kw = document.getElementById('catalogKeyword').value.trim();
      const grid = document.getElementById('catalogResults');
      grid.innerHTML = '<div style="padding:14px;font-family:var(--mono);font-size:12px;">QUERYING CATALOG.ROBLOX.COM...</div>';
      const res = await fetch('/api/catalog/search?keyword=' + encodeURIComponent(kw));
      const data = await res.json();
      if (data.error) {
        grid.innerHTML = '<div style="padding:14px;color:var(--ag-red);">' + data.error + '</div>';
        return;
      }
      grid.innerHTML = (data.items || []).map(item =>
        '<div class="catalog-item">' +
          (item.thumbnailUrl ? '<img class="catalog-thumb" src="' + item.thumbnailUrl + '" alt="' + item.name + '" />' : '') +
          '<a href="https://www.roblox.com/catalog/' + item.id + '" target="_blank">' + item.name + '</a>' +
          '<div class="muted" style="font-family:var(--mono);font-size:11px;">ID ' + item.id + ' // ' + item.creatorName + '</div>' +
          '<span class="price-tag">' +
            (item.price !== undefined ? (item.price + ' ROBUX') : (item.priceStatus || 'OFFSALE').toUpperCase()) +
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
      const child = spawn(exe, [`--app=${url}`, "--window-size=1280,840"], {
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
