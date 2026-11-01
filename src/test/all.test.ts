import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import {
  evaluateSplitRoute,
  generatePacScript,
  isRobloxGameServerIp,
  parseTunnelUri
} from "../proxy/domain-rules.js";
import { generateSingBoxConfig } from "../proxy/singbox-config.js";
import { SplitTunnelProxyServer } from "../proxy/split-proxy.js";
import {
  fetchGlobalWindowsPlayerVersion,
  fetchPackageManifest
} from "../bootstrapper/roblox-bootstrapper.js";
import { searchGlobalCatalog } from "../catalog/global-catalog.js";
import { ConfigStore, DEFAULT_SETTINGS } from "../config-store.js";
import { DashboardServer } from "../ui/dashboard-server.js";
import { buildReleaseArtifacts } from "../packager/build-release.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const execFileAsync = promisify(execFile);

test("Split-tunnel route evaluator routes *.roblox.com to GLOBAL_TUNNEL and UDP/CDN to DIRECT_ISP", () => {
  const settings = {
    routeRbxCdnDirect: true,
    blockVngRedirects: true
  };

  const catalogRoute = evaluateSplitRoute("catalog.roblox.com", 443, "TCP", settings);
  assert.equal(catalogRoute.decision, "GLOBAL_TUNNEL");

  const authRoute = evaluateSplitRoute("auth.roblox.com", 443, "TCP", settings);
  assert.equal(authRoute.decision, "GLOBAL_TUNNEL");

  const gameJoinRoute = evaluateSplitRoute("gamejoin.roblox.com", 443, "TCP", settings);
  assert.equal(gameJoinRoute.decision, "GLOBAL_TUNNEL");

  const cdnRoute = evaluateSplitRoute("setup.rbxcdn.com", 443, "TCP", settings);
  assert.equal(cdnRoute.decision, "DIRECT_ISP");

  const vngRoute = evaluateSplitRoute("roblox.vnggames.com", 443, "TCP", settings);
  assert.equal(vngRoute.decision, "BLOCK_VNG_TELEMETRY");

  const udpRoute = evaluateSplitRoute("128.116.50.10", 55000, "UDP", settings);
  assert.equal(udpRoute.decision, "DIRECT_ISP");

  const gameServerTcpCheck = evaluateSplitRoute("128.116.10.25", 50000, "TCP", settings);
  assert.equal(gameServerTcpCheck.decision, "DIRECT_ISP");
  assert.equal(isRobloxGameServerIp("128.116.120.5"), true);
  assert.equal(isRobloxGameServerIp("128.116.200.5"), false);
});

test("Tunnel URI parser supports SOCKS5, HTTP, WireGuard/WARP, VLESS, and Shadowsocks", () => {
  const socks = parseTunnelUri("socks5://alice:secret@sg.example.com:1080#SG-Socks");
  assert.equal(socks.protocol, "socks5");
  assert.equal(socks.server, "sg.example.com");
  assert.equal(socks.serverPort, 1080);
  assert.equal(socks.username, "alice");
  assert.equal(socks.password, "secret");
  assert.equal(socks.name, "SG-Socks");

  const httpProxy = parseTunnelUri("https://proxyuser:proxypass@hk.example.com:8443#HK-HTTPS");
  assert.equal(httpProxy.protocol, "http");
  assert.equal(httpProxy.tls, true);
  assert.equal(httpProxy.serverPort, 8443);

  const vless = parseTunnelUri(
    "vless://11111111-2222-3333-4444-555555555555@jp.example.com:443?security=reality&sni=www.microsoft.com&pbk=pubkey123&sid=abcd&type=tcp&flow=xtls-rprx-vision#JP-Reality"
  );
  assert.equal(vless.protocol, "vless");
  assert.equal(vless.uuid, "11111111-2222-3333-4444-555555555555");
  assert.equal(vless.tls, true);
  assert.equal(vless.realityPublicKey, "pubkey123");

  const ssUserInfo = Buffer.from("aes-256-gcm:mypassword123", "utf8").toString("base64");
  const ss = parseTunnelUri(`ss://${ssUserInfo}@sg2.example.com:8388#SG-SS`);
  assert.equal(ss.protocol, "shadowsocks");
  assert.equal(ss.method, "aes-256-gcm");
  assert.equal(ss.password, "mypassword123");

  const wg = parseTunnelUri(
    "wg://cHJpdmF0ZWtleTEyMw==@162.159.192.1:2408?address=172.16.0.2/32&reserved=12,34,56#WARP-SG"
  );
  assert.equal(wg.protocol, "wireguard");
  assert.deepEqual(wg.reserved, [12, 34, 56]);

  const singBoxCfg = generateSingBoxConfig(vless, DEFAULT_SETTINGS, true);
  assert.equal(singBoxCfg.outbounds[0].type, "vless");
  const hasUdpDirect = singBoxCfg.route.rules.some(
    (r) => r.network === "udp" && r.outbound === "direct"
  );
  assert.equal(hasUdpDirect, true);
});

test("SplitTunnelProxyServer tunnels *.roblox.com through SOCKS5 upstream and blocks vnggames.com", async () => {
  // 1. Start a real TCP echo server representing the target destination
  const echoServer = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      socket.write(Buffer.concat([Buffer.from("ECHO:"), chunk]));
    });
  });
  await new Promise<void>((res) => echoServer.listen(0, "127.0.0.1", () => res()));
  const echoPort = (echoServer.address() as net.AddressInfo).port;

  // 2. Start a real RFC 1928 SOCKS5 server that forwards to 127.0.0.1:echoPort and records requested hostnames
  const socksObservedDomains: string[] = [];
  const socksServer = net.createServer((client) => {
    let stage = 0;
    client.on("data", (data) => {
      if (stage === 0) {
        // Greeting reply: VER 5, METHOD 0 (No auth)
        stage = 1;
        client.write(Buffer.from([0x05, 0x00]));
      } else if (stage === 1) {
        stage = 2;
        const atyp = data[3];
        let domain = "";
        let port = echoPort;
        if (atyp === 0x03) {
          const len = data[4];
          domain = data.subarray(5, 5 + len).toString("utf8");
          port = data.readUInt16BE(5 + len);
        }
        socksObservedDomains.push(`${domain}:${port}`);

        const targetConn = net.connect({ host: "127.0.0.1", port: echoPort }, () => {
          // Send SOCKS5 success reply: VER=5, REP=0, RSV=0, ATYP=1, IP=127.0.0.1, PORT=echoPort
          const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]);
          reply.writeUInt16BE(echoPort, 8);
          client.write(reply);
          client.pipe(targetConn);
          targetConn.pipe(client);
        });
      }
    });
  });
  await new Promise<void>((res) => socksServer.listen(0, "127.0.0.1", () => res()));
  const socksPort = (socksServer.address() as net.AddressInfo).port;

  // 3. Start SplitTunnelProxyServer configured with our real SOCKS5 server
  const upstreamId = "test-socks";
  const splitProxy = new SplitTunnelProxyServer({
    listenHost: "127.0.0.1",
    listenPort: 0,
    routeRbxCdnDirect: true,
    blockVngRedirects: true,
    autoConfigureWindowsPac: false,
    activeUpstreamId: upstreamId,
    upstreams: [
      {
        id: upstreamId,
        name: "Test-SG-SOCKS5",
        protocol: "socks5",
        server: "127.0.0.1",
        serverPort: socksPort
      }
    ]
  });

  const proxyPort = await splitProxy.start();

  try {
    // 4. Verify PAC file generation over HTTP
    const pacScript = generatePacScript("127.0.0.1", proxyPort, {
      routeRbxCdnDirect: true,
      blockVngRedirects: true
    });
    assert.match(pacScript, /FindProxyForURL/);
    assert.match(pacScript, /roblox\.com/);

    // 5. Connect to catalog.roblox.com via SplitTunnelProxyServer HTTP CONNECT -> must go through SOCKS5
    const tunneledReply = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: proxyPort,
        method: "CONNECT",
        path: `catalog.roblox.com:${echoPort}`
      });
      req.once("connect", (res, socket) => {
        assert.equal(res.statusCode, 200);
        socket.once("data", (chunk: Buffer) => {
          socket.destroy();
          resolve(chunk.toString("utf8"));
        });
        socket.write("HELLO_GLOBAL_CATALOG");
      });
      req.once("error", reject);
      req.end();
    });

    assert.equal(tunneledReply, "ECHO:HELLO_GLOBAL_CATALOG");
    assert.deepEqual(socksObservedDomains, [`catalog.roblox.com:${echoPort}`]);

    // 6. Connect to roblox.vnggames.com -> must be blocked with HTTP 403
    const blockedStatus = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: proxyPort,
        method: "CONNECT",
        path: "roblox.vnggames.com:443"
      });
      req.once("connect", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode || 0);
      });
      req.once("error", reject);
      req.end();
    });
    assert.equal(blockedStatus, 403);
  } finally {
    await splitProxy.stop();
    await new Promise<void>((res) => socksServer.close(() => res()));
    await new Promise<void>((res) => echoServer.close(() => res()));
  }
});

test("Bootstrapper fetches real Global WindowsPlayer version and manifest from setup.rbxcdn.com", async () => {
  const versionInfo = await fetchGlobalWindowsPlayerVersion();
  assert.ok(versionInfo.version.length > 0);
  assert.match(versionInfo.clientVersionUpload, /^version-[a-f0-9]+$/i);

  const manifest = await fetchPackageManifest(versionInfo.clientVersionUpload);
  assert.ok(manifest.length > 5);
  const robloxAppEntry = manifest.find((m) => m.fileName === "RobloxApp.zip");
  assert.ok(robloxAppEntry, "Manifest must contain RobloxApp.zip");
  assert.match(robloxAppEntry.md5, /^[a-f0-9]{32}$/i);
});

test("Global Catalog search queries catalog.roblox.com through SplitTunnelProxyServer", async () => {
  const splitProxy = new SplitTunnelProxyServer({
    ...DEFAULT_SETTINGS,
    listenPort: 0
  });
  const proxyPort = await splitProxy.start();
  try {
    const items = await searchGlobalCatalog({
      keyword: "Fedora",
      limit: 10,
      proxyHost: "127.0.0.1",
      proxyPort
    });
    assert.ok(items.length > 0, "Expected catalog items from catalog.roblox.com");
    assert.ok(items[0].id > 0);
    assert.ok(items[0].name.length > 0);
  } finally {
    await splitProxy.stop();
  }
});

test("DashboardServer serves Desktop Control Center HTML and manages upstream profiles", async () => {
  const tempSettingsFile = path.join(
    os.tmpdir(),
    `roblox-split-test-${Date.now()}.json`
  );
  const store = new ConfigStore(tempSettingsFile);
  const splitProxy = new SplitTunnelProxyServer({
    ...store.getSettings(),
    listenPort: 0
  });
  await splitProxy.start();
  const dashboard = new DashboardServer(store, splitProxy, 0);
  const uiPort = await dashboard.start();

  try {
    const htmlResp = await fetch(`http://127.0.0.1:${uiPort}/`);
    assert.equal(htmlResp.status, 200);
    const htmlText = await htmlResp.text();
    assert.match(htmlText, /Roblox Global Split-Tunnel & Bootstrapper/);

    const addResp = await fetch(`http://127.0.0.1:${uiPort}/api/upstreams/uri`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uri: "socks5://sg-relay.example.com:1080#Singapore-Exit"
      })
    });
    assert.equal(addResp.status, 200);
    const addJson = (await addResp.json()) as { added: { name: string } };
    assert.equal(addJson.added.name, "Singapore-Exit");

    const sbResp = await fetch(`http://127.0.0.1:${uiPort}/api/singbox-config`);
    assert.equal(sbResp.status, 200);
    const sbJson = (await sbResp.json()) as {
      outbounds: Array<{ type: string; server: string }>;
    };
    assert.equal(sbJson.outbounds[0].type, "socks");
    assert.equal(sbJson.outbounds[0].server, "sg-relay.example.com");
  } finally {
    await dashboard.stop();
    await splitProxy.stop();
    if (fs.existsSync(tempSettingsFile)) {
      fs.unlinkSync(tempSettingsFile);
    }
  }
});

test("ConfigStore auto-provisions default Cloudflare WARP WireGuard upstream when empty", async () => {
  const tempSettingsFile = path.join(
    os.tmpdir(),
    `roblox-warp-default-${Date.now()}.json`
  );
  const store = new ConfigStore(tempSettingsFile);
  try {
    assert.equal(store.getSettings().autoConfigureWindowsPac, true);
    const defaultTunnel = await store.ensureDefaultWiredUpstream();
    assert.equal(defaultTunnel.protocol, "wireguard");
    assert.ok(defaultTunnel.privateKey.length > 20);
    assert.equal(store.getSettings().activeUpstreamId, defaultTunnel.id);
  } finally {
    if (fs.existsSync(tempSettingsFile)) {
      fs.unlinkSync(tempSettingsFile);
    }
  }
});

test("Release packager compiles RobloxGlobalLauncher.exe, builds ZIP, and compiles working RobloxGlobalSplitSetup.exe installer", async () => {
  const artifacts = await buildReleaseArtifacts(process.cwd());
  assert.ok(fs.existsSync(artifacts.launcherExePath), "RobloxGlobalLauncher.exe must exist");
  assert.ok(fs.existsSync(artifacts.portableZipPath), "Portable ZIP must exist");
  assert.ok(artifacts.portableZipBytes > 1000000, "Portable ZIP must contain bundled runtime");
  assert.ok(fs.existsSync(artifacts.installerExePath), "RobloxGlobalSplitSetup.exe must exist");
  assert.ok(artifacts.installerExeBytes > 1000000, "Setup installer must embed payload.zip");

  const tempInstallTarget = path.join(
    os.tmpdir(),
    `RobloxGlobalSplitInstalled-${Date.now()}`
  );
  try {
    const { stdout } = await execFileAsync(artifacts.installerExePath, [
      "--silent",
      `--dir=${tempInstallTarget}`
    ]);
    assert.match(stdout, /Installed silently to:/);
    assert.ok(
      fs.existsSync(path.join(tempInstallTarget, "RobloxGlobalLauncher.exe")),
      "Installer must extract RobloxGlobalLauncher.exe"
    );
    assert.ok(
      fs.existsSync(path.join(tempInstallTarget, "dist", "cli.js")),
      "Installer must extract dist/cli.js"
    );
    assert.ok(
      fs.existsSync(path.join(tempInstallTarget, ".runtime", "bin", "sing-box.exe")),
      "Installer must extract bundled sing-box.exe"
    );
  } finally {
    if (fs.existsSync(tempInstallTarget)) {
      fs.rmSync(tempInstallTarget, { recursive: true, force: true });
    }
  }
});



