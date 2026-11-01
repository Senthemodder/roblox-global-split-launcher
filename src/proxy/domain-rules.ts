import { RouteDecision, SplitTunnelSettings, UpstreamTunnelConfig } from "../types.js";

/**
 * Roblox domains that carry account region checks, authentication, global catalog queries,
 * and join tickets. These MUST route through a non-VN exit IP so Roblox's backend never
 * associates the session or account with a Vietnamese ISP IP.
 */
export const ROBLOX_GLOBAL_API_SUFFIXES: readonly string[] = [
  "roblox.com",
  "robloxlabs.com",
  "rbx.com"
];

/**
 * Specific VNG regional redirect / telemetry endpoints that trigger forced migration prompts.
 */
export const VNG_REDIRECT_HOSTS: readonly string[] = [
  "vnggames.com",
  "roblox.vnggames.com",
  "pay.zing.vn",
  "id.zing.vn"
];

/**
 * Roblox high-bandwidth content delivery networks (textures, meshes, client zip packages).
 * Can be routed DIRECT for full local ISP download speed without exposing account region
 * unless the user turns off routeRbxCdnDirect.
 */
export const ROBLOX_CDN_SUFFIXES: readonly string[] = [
  "rbxcdn.com"
];

/**
 * Roblox UDP game server CIDR blocks (e.g. 128.116.0.0/17).
 * Gameplay UDP packets go directly over the local ISP for native ping.
 */
export const ROBLOX_GAME_UDP_CIDRS: readonly string[] = [
  "128.116.0.0/17"
];

export interface RouteEvaluation {
  decision: RouteDecision;
  reason: string;
}

export function normalizeHostname(rawHost: string): string {
  const trimmed = rawHost.trim().toLowerCase();
  const bracketStripped = trimmed.startsWith("[") && trimmed.includes("]")
    ? trimmed.slice(1, trimmed.indexOf("]"))
    : trimmed.split(":")[0];
  return bracketStripped.replace(/\.$/, "");
}

function matchesDomainSuffix(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

export function isRobloxGameServerIp(ip: string): boolean {
  const parts = ip.trim().split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return false;
  }
  // 128.116.0.0/17 covers 128.116.0.0 - 128.116.127.255
  return parts[0] === 128 && parts[1] === 116 && parts[2] >= 0 && parts[2] <= 127;
}

export function evaluateSplitRoute(
  rawHost: string,
  port: number,
  transport: "TCP" | "UDP" | "HTTP",
  settings: Pick<SplitTunnelSettings, "routeRbxCdnDirect" | "blockVngRedirects">
): RouteEvaluation {
  const host = normalizeHostname(rawHost);

  if (transport === "UDP") {
    return {
      decision: "DIRECT_ISP",
      reason: "UDP gameplay traffic bypasses tunnel for native ISP ping"
    };
  }

  if (isRobloxGameServerIp(host)) {
    return {
      decision: "DIRECT_ISP",
      reason: "Roblox game server IP (128.116.0.0/17) routed directly for zero ping penalty"
    };
  }

  if (settings.blockVngRedirects && VNG_REDIRECT_HOSTS.some((s) => matchesDomainSuffix(host, s))) {
    return {
      decision: "BLOCK_VNG_TELEMETRY",
      reason: `Blocked VNG regional redirect/login host (${host}) to prevent accidental account binding`
    };
  }

  if (ROBLOX_CDN_SUFFIXES.some((s) => matchesDomainSuffix(host, s))) {
    if (settings.routeRbxCdnDirect) {
      return {
        decision: "DIRECT_ISP",
        reason: `Roblox static asset CDN (${host}:${port}) routed directly for fast downloads`
      };
    }
    return {
      decision: "GLOBAL_TUNNEL",
      reason: `Roblox CDN (${host}:${port}) routed via global tunnel per user setting`
    };
  }

  if (ROBLOX_GLOBAL_API_SUFFIXES.some((s) => matchesDomainSuffix(host, s))) {
    return {
      decision: "GLOBAL_TUNNEL",
      reason: `Roblox API/Catalog/Auth domain (${host}:${port}) routed via non-VN tunnel`
    };
  }

  return {
    decision: "DIRECT_ISP",
    reason: `Non-Roblox traffic (${host}:${port}) routed directly over local ISP`
  };
}

/**
 * Generates a standard PAC (Proxy Auto-Configuration) script so Windows WinHTTP,
 * browsers, and RobloxPlayerBeta.exe HTTP calls route only *.roblox.com through the
 * local split-tunnel proxy while keeping everything else DIRECT.
 */
export function generatePacScript(
  proxyHost: string,
  proxyPort: number,
  settings: Pick<SplitTunnelSettings, "routeRbxCdnDirect" | "blockVngRedirects">
): string {
  const proxyDirective = `PROXY ${proxyHost}:${proxyPort}; DIRECT`;
  const blockDirective = "PROXY 127.0.0.1:9";
  const cdnRule = settings.routeRbxCdnDirect
    ? `  if (dnsDomainIs(h, "rbxcdn.com") || shExpMatch(h, "*.rbxcdn.com")) {\n    return "DIRECT";\n  }`
    : `  if (dnsDomainIs(h, "rbxcdn.com") || shExpMatch(h, "*.rbxcdn.com")) {\n    return "${proxyDirective}";\n  }`;
  const vngRule = settings.blockVngRedirects
    ? `  if (dnsDomainIs(h, "vnggames.com") || shExpMatch(h, "*.vnggames.com") || shExpMatch(h, "*.zing.vn")) {\n    return "${blockDirective}";\n  }`
    : "";

  return [
    "function FindProxyForURL(url, host) {",
    "  var h = host.toLowerCase();",
    vngRule,
    cdnRule,
    '  if (h === "roblox.com" || dnsDomainIs(h, ".roblox.com") || shExpMatch(h, "*.roblox.com") || h === "rbx.com" || dnsDomainIs(h, ".rbx.com")) {',
    `    return "${proxyDirective}";`,
    "  }",
    '  return "DIRECT";',
    "}"
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Parses standard proxy/tunnel URI strings:
 * - socks5://[user:pass@]host:port[#name]
 * - http://[user:pass@]host:port[#name] or https://[user:pass@]host:port[#name]
 * - vless://uuid@host:port?security=tls&sni=...&type=ws#name
 * - ss://base64(method:password)@host:port#name
 * - wg://privateKey@host:port?publicKey=...&address=172.16.0.2/32&reserved=1,2,3#name
 */
export function parseTunnelUri(uri: string, customName?: string): UpstreamTunnelConfig {
  const trimmed = uri.trim();
  const parsed = new URL(trimmed);
  const protocolRaw = parsed.protocol.replace(":", "").toLowerCase();
  const tagFromHash = parsed.hash ? decodeURIComponent(parsed.hash.slice(1)).trim() : "";
  const id = `tunnel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const server = parsed.hostname;
  const serverPort = parsed.port ? Number.parseInt(parsed.port, 10) : 0;

  if (!server || Number.isNaN(serverPort) || serverPort <= 0 || serverPort > 65535) {
    throw new Error(`Invalid server host or port in tunnel URI: ${trimmed}`);
  }

  if (protocolRaw === "socks5" || protocolRaw === "socks5h" || protocolRaw === "socks") {
    return {
      id,
      name: customName || tagFromHash || `SOCKS5 (${server}:${serverPort})`,
      protocol: "socks5",
      server,
      serverPort,
      username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined
    };
  }

  if (protocolRaw === "http" || protocolRaw === "https") {
    return {
      id,
      name: customName || tagFromHash || `${protocolRaw.toUpperCase()} (${server}:${serverPort})`,
      protocol: "http",
      server,
      serverPort,
      tls: protocolRaw === "https",
      username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined
    };
  }

  if (protocolRaw === "vless") {
    const uuid = decodeURIComponent(parsed.username);
    if (!uuid) {
      throw new Error("VLESS URI requires a UUID before '@'");
    }
    const security = (parsed.searchParams.get("security") || "none").toLowerCase();
    const sni = parsed.searchParams.get("sni") || parsed.searchParams.get("servername") || undefined;
    const pbk = parsed.searchParams.get("pbk") || undefined;
    const sid = parsed.searchParams.get("sid") || undefined;
    const flow = parsed.searchParams.get("flow") || undefined;
    const typeParam = (parsed.searchParams.get("type") || "tcp").toLowerCase();
    const transportType: "tcp" | "ws" | "grpc" =
      typeParam === "ws" || typeParam === "grpc" ? typeParam : "tcp";
    const transportPath =
      parsed.searchParams.get("path") || parsed.searchParams.get("serviceName") || undefined;

    return {
      id,
      name: customName || tagFromHash || `VLESS (${server}:${serverPort})`,
      protocol: "vless",
      server,
      serverPort,
      uuid,
      flow,
      tls: security === "tls" || security === "reality",
      serverName: sni,
      realityPublicKey: pbk,
      realityShortId: sid,
      transportType,
      transportPath
    };
  }

  if (protocolRaw === "ss") {
    let method = "";
    let password = "";
    if (parsed.password) {
      method = decodeURIComponent(parsed.username);
      password = decodeURIComponent(parsed.password);
    } else if (parsed.username) {
      const decoded = Buffer.from(decodeURIComponent(parsed.username), "base64").toString("utf8");
      const colonIdx = decoded.indexOf(":");
      if (colonIdx === -1) {
        throw new Error("Invalid base64 userinfo in Shadowsocks URI");
      }
      method = decoded.slice(0, colonIdx);
      password = decoded.slice(colonIdx + 1);
    }
    if (!method || !password) {
      throw new Error("Shadowsocks URI requires method and password");
    }
    return {
      id,
      name: customName || tagFromHash || `Shadowsocks (${server}:${serverPort})`,
      protocol: "shadowsocks",
      server,
      serverPort,
      method,
      password
    };
  }

  if (protocolRaw === "wg" || protocolRaw === "wireguard") {
    const privateKey = decodeURIComponent(parsed.username || parsed.searchParams.get("privateKey") || "");
    const peerPublicKey =
      parsed.searchParams.get("publicKey") ||
      parsed.searchParams.get("peerPublicKey") ||
      "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo="; // default Cloudflare WARP public key if omitted
    const addressParam = parsed.searchParams.get("address") || "172.16.0.2/32";
    const localAddress = addressParam.split(",").map((a) => a.trim()).filter(Boolean);
    const reservedParam = parsed.searchParams.get("reserved");
    let reserved: [number, number, number] | undefined;
    if (reservedParam) {
      const nums = reservedParam.split(",").map((n) => Number.parseInt(n.trim(), 10));
      if (nums.length === 3 && nums.every((n) => !Number.isNaN(n))) {
        reserved = [nums[0], nums[1], nums[2]];
      }
    }
    const mtuParam = parsed.searchParams.get("mtu");
    const mtu = mtuParam ? Number.parseInt(mtuParam, 10) : 1280;

    if (!privateKey) {
      throw new Error("WireGuard/WARP URI requires privateKey");
    }

    return {
      id,
      name: customName || tagFromHash || `WireGuard/WARP (${server}:${serverPort})`,
      protocol: "wireguard",
      server,
      serverPort,
      localAddress,
      privateKey,
      peerPublicKey,
      reserved,
      mtu
    };
  }

  throw new Error(`Unsupported tunnel protocol '${protocolRaw}'. Supported: socks5, http, https, wg, vless, ss`);
}
