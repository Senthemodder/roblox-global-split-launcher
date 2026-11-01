#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ConfigStore } from "./config-store.js";
import { parseTunnelUri } from "./proxy/domain-rules.js";
import { generateSingBoxConfig } from "./proxy/singbox-config.js";
import { SingBoxBridgeRunner } from "./proxy/singbox-runner.js";
import {
  SplitTunnelProxyServer,
  disableWindowsPac,
  enableWindowsPac
} from "./proxy/split-proxy.js";
import {
  detectLocalInstallations,
  downloadGlobalBootstrapperExe,
  fetchGlobalWindowsPlayerVersion,
  installGlobalRobloxClient,
  launchGlobalRobloxClient
} from "./bootstrapper/roblox-bootstrapper.js";
import {
  checkRegionAndSplitStatus,
  searchGlobalCatalog
} from "./catalog/global-catalog.js";
import { DashboardServer, openDesktopAppWindow } from "./ui/dashboard-server.js";
import { buildReleaseArtifacts } from "./packager/build-release.js";

function freeStaleLocalPorts(ports: number[]): void {
  if (process.platform !== "win32") {
    return;
  }
  try {
    const out = execFileSync("netstat.exe", ["-ano", "-p", "tcp"], {
      encoding: "utf8",
      windowsHide: true
    });
    const lines = out.split(/\r?\n/);
    const killed = new Set<number>();
    for (const line of lines) {
      if (!line.includes("LISTENING")) {
        continue;
      }
      for (const port of ports) {
        if (line.includes(`127.0.0.1:${port} `) || line.includes(`0.0.0.0:${port} `)) {
          const parts = line.trim().split(/\s+/);
          const pid = Number(parts[parts.length - 1]);
          if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && !killed.has(pid)) {
            killed.add(pid);
            try {
              process.kill(pid);
            } catch {
              // Ignore if already exited
            }
          }
        }
      }
    }
  } catch {
    // Ignore netstat errors
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = (args[0] || "ui").toLowerCase();
  const store = new ConfigStore();

  if (command === "status") {
    const activeUpstream = await store.ensureDefaultWiredUpstream();
    const settings = store.getSettings();
    const sbRunner = new SingBoxBridgeRunner(7897);
    let sbPort: number | undefined;
    if (
      activeUpstream.protocol === "wireguard" ||
      activeUpstream.protocol === "vless" ||
      activeUpstream.protocol === "shadowsocks"
    ) {
      sbPort = await sbRunner.startWithUpstream(activeUpstream, settings);
    }

    const proxy = new SplitTunnelProxyServer({ ...settings, listenPort: 0 }, sbPort);
    const proxyPort = await proxy.start();
    try {
      const [liveVer, localInst, region] = await Promise.all([
        fetchGlobalWindowsPlayerVersion(),
        Promise.resolve(detectLocalInstallations()),
        checkRegionAndSplitStatus({
          proxyHost: "127.0.0.1",
          proxyPort,
          hasActiveUpstream: true,
          activeUpstream,
          singBoxLocalSocksPort: sbPort
        })
      ]);

      console.log("=== Roblox Global Split-Tunnel & Bootstrapper Status ===");
      console.log(
        `Latest Global WindowsPlayer : ${liveVer.version} (${liveVer.clientVersionUpload})`
      );
      console.log(
        `Local Global Installed      : ${
          localInst.globalInstalled
            ? `${localInst.installedVersionUpload} (${localInst.globalExecutablePath})`
            : "Not Installed"
        }`
      );
      console.log(
        `VNG Client Conflict         : ${
          localInst.vngDetected ? `FOUND (${localInst.vngPaths.join(", ")})` : "None (Clean)"
        }`
      );
      console.log(
        `Default Wired Upstream      : ${activeUpstream.name} (${activeUpstream.protocol}://${activeUpstream.server}:${activeUpstream.serverPort})`
      );
      console.log(
        `Direct Gameplay ISP         : ${region.directIp} (${region.directCountryCode} / ${region.directIsp})`
      );
      console.log(`*.roblox.com Tunnel Exit    : ${region.proxiedIp} (${region.proxiedCountryCode})`);
      console.log(`VNG Lock Risk Assessment    : ${region.vngRiskLevel}`);
      console.log(`Summary                     : ${region.summary}`);
    } finally {
      await proxy.stop();
      await sbRunner.stop();
    }
    return;
  }

  if (command === "add-tunnel") {
    const uri = args[1];
    const customName = args[2];
    if (!uri) {
      console.error("Usage: roblox-global add-tunnel <socks5|http|vless|ss|wg URI> [name]");
      process.exit(1);
    }
    const parsed = parseTunnelUri(uri, customName);
    store.addUpstream(parsed, true);
    console.log(
      `Added and activated upstream tunnel: ${parsed.name} (${parsed.protocol}://${parsed.server}:${parsed.serverPort})`
    );
    return;
  }

  if (command === "export-singbox") {
    const outPath =
      args[1] || path.join(process.cwd(), ".runtime", "sing-box-roblox-split.json");
    const active = await store.ensureDefaultWiredUpstream();
    const settings = store.getSettings();
    const cfg = generateSingBoxConfig(active, settings, args.includes("--tun"));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(cfg, null, 2), "utf8");
    console.log(`Generated sing-box split-tunnel config at: ${outPath}`);
    return;
  }

  if (command === "catalog") {
    const keyword = args.slice(1).join(" ").trim();
    const activeUpstream = await store.ensureDefaultWiredUpstream();
    const settings = store.getSettings();
    const sbRunner = new SingBoxBridgeRunner(7897);
    let sbPort: number | undefined;
    if (
      activeUpstream.protocol === "wireguard" ||
      activeUpstream.protocol === "vless" ||
      activeUpstream.protocol === "shadowsocks"
    ) {
      sbPort = await sbRunner.startWithUpstream(activeUpstream, settings);
    }
    const proxy = new SplitTunnelProxyServer({ ...settings, listenPort: 0 }, sbPort);
    const proxyPort = await proxy.start();
    try {
      const items = await searchGlobalCatalog({
        keyword,
        limit: 10,
        proxyHost: "127.0.0.1",
        proxyPort
      });
      console.log(
        `=== Roblox Global Catalog Results (${items.length} items${
          keyword ? ` for '${keyword}'` : ""
        }) ===`
      );
      for (const item of items) {
        const priceLabel =
          item.price !== undefined ? `${item.price} Robux` : item.priceStatus || "Offsale";
        console.log(
          `- [${item.id}] ${item.name} | ${priceLabel} | By ${item.creatorName} -> https://www.roblox.com/catalog/${item.id}`
        );
      }
    } finally {
      await proxy.stop();
      await sbRunner.stop();
    }
    return;
  }

  if (command === "download-installer") {
    const liveVer = await fetchGlobalWindowsPlayerVersion();
    const destDir = path.join(process.cwd(), ".runtime", "installers");
    const installerPath = await downloadGlobalBootstrapperExe(
      liveVer.clientVersionUpload,
      destDir
    );
    console.log(
      `Downloaded official Global Roblox Bootstrapper (${liveVer.version} / ${liveVer.clientVersionUpload}) to:\n${installerPath}`
    );
    return;
  }

  if (command === "install-global") {
    const liveVer = await fetchGlobalWindowsPlayerVersion();
    console.log(
      `Installing Global Roblox WindowsPlayer ${liveVer.version} (${liveVer.clientVersionUpload}) from setup.rbxcdn.com...`
    );
    const exePath = await installGlobalRobloxClient(
      liveVer.clientVersionUpload,
      undefined,
      (p) => {
        if (p.currentPackage) {
          console.log(
            `[${p.phase.toUpperCase()}] (${p.completedPackages + 1}/${p.totalPackages}) ${p.currentPackage}`
          );
        }
      }
    );
    console.log(`Installed Global RobloxPlayerBeta.exe at: ${exePath}`);
    return;
  }

  if (command === "launch") {
    const placeId = args[1];
    const launched = launchGlobalRobloxClient({ placeId });
    console.log(
      `Launched Global RobloxPlayerBeta.exe (PID: ${launched.pid}) -> ${launched.executablePath}`
    );
    return;
  }

  if (command === "package") {
    console.log("Building native Windows GUI launcher, portable ZIP, and Setup Installer (.exe)...");
    const result = await buildReleaseArtifacts(process.cwd());
    console.log(`Compiled Native Launcher : ${result.launcherExePath}`);
    console.log(
      `Created Portable ZIP     : ${result.portableZipPath} (${(result.portableZipBytes / (1024 * 1024)).toFixed(2)} MB)`
    );
    console.log(
      `Created Setup Installer  : ${result.installerExePath} (${(result.installerExeBytes / (1024 * 1024)).toFixed(2)} MB)`
    );
    return;
  }

  if (command === "ui") {
    freeStaleLocalPorts([7897, 7898, 7899]);
    const sbRunner = new SingBoxBridgeRunner(7897);
    const splitProxy = new SplitTunnelProxyServer(store.getSettings());
    const proxyPort = await splitProxy.start();
    const dashboard = new DashboardServer(store, splitProxy, 7898, sbRunner);
    const uiPort = await dashboard.start();
    const url = `http://127.0.0.1:${uiPort}`;

    try {
      const activeUpstream = await store.ensureDefaultWiredUpstream();
      splitProxy.updateSettings(store.getSettings());
      await dashboard.syncActiveUpstreamEngine();
      console.log(`Default Wired Tunnel        : ${activeUpstream.name} (${activeUpstream.protocol})`);
    } catch (err) {
      console.error(
        `Upstream initialization note: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const settings = store.getSettings();
    if (settings.autoConfigureWindowsPac) {
      await enableWindowsPac(splitProxy.getPacUrl());
    }

    console.log(`Split-Tunnel Proxy          : 127.0.0.1:${proxyPort}`);
    console.log(`PAC Auto-Configuration URL  : ${splitProxy.getPacUrl()}`);
    console.log(`Desktop Control Center UI   : ${url}`);

    if (!args.includes("--no-window")) {
      openDesktopAppWindow(url);
    }

    const shutdown = async (): Promise<void> => {
      if (store.getSettings().autoConfigureWindowsPac) {
        await disableWindowsPac();
      }
      await dashboard.stop();
      await splitProxy.stop();
      process.exit(0);
    };

    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
    return;
  }

  console.log(
    [
      "Roblox Global Split-Tunnel & Bootstrapper CLI",
      "Commands:",
      "  ui [--no-window]              Launch the Split-Tunnel Proxy & Desktop Control Center UI",
      "  status                        Verify live Global Roblox version, local client, and exit IP/region",
      "  add-tunnel <uri> [name]       Add & activate an upstream non-VN tunnel (socks5/http/wg/vless/ss)",
      "  export-singbox [path] [--tun] Export a complete sing-box split-tunnel JSON configuration",
      "  catalog [keyword]             Query the live Roblox Global Catalog via the split-tunnel",
      "  download-installer            Download official Global Roblox installer from setup.rbxcdn.com",
      "  install-global                Extract full Global RobloxPlayerBeta.exe directly from setup.rbxcdn.com",
      "  launch [placeId]              Launch Global RobloxPlayerBeta.exe"
    ].join("\n")
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
