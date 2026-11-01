import {
  ROBLOX_CDN_SUFFIXES,
  ROBLOX_GAME_UDP_CIDRS,
  ROBLOX_GLOBAL_API_SUFFIXES,
  VNG_REDIRECT_HOSTS
} from "./domain-rules.js";
import { SplitTunnelSettings, UpstreamTunnelConfig } from "../types.js";

export interface SingBoxOutbound {
  type: string;
  tag: string;
  [key: string]: unknown;
}

export interface SingBoxConfig {
  log: {
    level: string;
    timestamp: boolean;
  };
  dns: {
    servers: Array<Record<string, unknown>>;
    rules: Array<Record<string, unknown>>;
    final: string;
  };
  inbounds: Array<Record<string, unknown>>;
  outbounds: SingBoxOutbound[];
  route: {
    rules: Array<Record<string, unknown>>;
    final: string;
    auto_detect_interface: boolean;
  };
}

export function buildSingBoxOutbound(upstream: UpstreamTunnelConfig, tag = "global-exit"): SingBoxOutbound {
  switch (upstream.protocol) {
    case "socks5": {
      const out: SingBoxOutbound = {
        type: "socks",
        tag,
        server: upstream.server,
        server_port: upstream.serverPort,
        version: "5"
      };
      if (upstream.username) {
        out.username = upstream.username;
      }
      if (upstream.password) {
        out.password = upstream.password;
      }
      return out;
    }

    case "http": {
      const out: SingBoxOutbound = {
        type: "http",
        tag,
        server: upstream.server,
        server_port: upstream.serverPort
      };
      if (upstream.username) {
        out.username = upstream.username;
      }
      if (upstream.password) {
        out.password = upstream.password;
      }
      if (upstream.tls) {
        out.tls = {
          enabled: true,
          server_name: upstream.server
        };
      }
      return out;
    }

    case "wireguard": {
      const out: SingBoxOutbound = {
        type: "wireguard",
        tag,
        server: upstream.server,
        server_port: upstream.serverPort,
        local_address: upstream.localAddress,
        private_key: upstream.privateKey,
        peer_public_key: upstream.peerPublicKey,
        mtu: upstream.mtu ?? 1280
      };
      if (upstream.presharedKey) {
        out.pre_shared_key = upstream.presharedKey;
      }
      if (upstream.reserved) {
        out.reserved = upstream.reserved;
      }
      return out;
    }

    case "vless": {
      const out: SingBoxOutbound = {
        type: "vless",
        tag,
        server: upstream.server,
        server_port: upstream.serverPort,
        uuid: upstream.uuid
      };
      if (upstream.flow) {
        out.flow = upstream.flow;
      }
      if (upstream.tls) {
        const tlsConfig: Record<string, unknown> = {
          enabled: true,
          server_name: upstream.serverName || upstream.server
        };
        if (upstream.realityPublicKey) {
          tlsConfig.reality = {
            enabled: true,
            public_key: upstream.realityPublicKey,
            short_id: upstream.realityShortId || ""
          };
          tlsConfig.utls = {
            enabled: true,
            fingerprint: "chrome"
          };
        }
        out.tls = tlsConfig;
      }
      if (upstream.transportType === "ws") {
        out.transport = {
          type: "ws",
          path: upstream.transportPath || "/"
        };
      } else if (upstream.transportType === "grpc") {
        out.transport = {
          type: "grpc",
          service_name: upstream.transportPath || ""
        };
      }
      return out;
    }

    case "shadowsocks": {
      return {
        type: "shadowsocks",
        tag,
        server: upstream.server,
        server_port: upstream.serverPort,
        method: upstream.method,
        password: upstream.password
      };
    }
  }
}

/**
 * Generates a complete sing-box configuration that routes ONLY *.roblox.com TCP traffic
 * through the upstream non-VN tunnel while keeping all UDP gameplay and CDN downloads direct.
 */
export function generateSingBoxConfig(
  upstream: UpstreamTunnelConfig,
  settings: Pick<
    SplitTunnelSettings,
    "listenHost" | "listenPort" | "routeRbxCdnDirect" | "blockVngRedirects"
  >,
  enableTunInterface = false
): SingBoxConfig {
  const globalOutbound = buildSingBoxOutbound(upstream, "global-exit");

  const inbounds: Array<Record<string, unknown>> = [
    {
      type: "mixed",
      tag: "mixed-in",
      listen: settings.listenHost,
      listen_port: settings.listenPort,
      set_system_proxy: false
    }
  ];

  if (enableTunInterface) {
    inbounds.push({
      type: "tun",
      tag: "tun-in",
      interface_name: "RobloxGlobalSplit",
      inet4_address: "172.19.0.1/30",
      auto_route: true,
      strict_route: false,
      stack: "system"
    });
  }

  const routeRules: Array<Record<string, unknown>> = [
    {
      protocol: "dns",
      outbound: "dns-out"
    },
    {
      // Guarantee zero VPN latency for all Roblox UDP gameplay packets
      network: "udp",
      outbound: "direct"
    },
    {
      // Guarantee Roblox game server subnet goes directly over local ISP
      ip_cidr: [...ROBLOX_GAME_UDP_CIDRS],
      outbound: "direct"
    }
  ];

  if (settings.blockVngRedirects) {
    routeRules.push({
      domain_suffix: [...VNG_REDIRECT_HOSTS],
      outbound: "block"
    });
  }

  if (settings.routeRbxCdnDirect) {
    routeRules.push({
      domain_suffix: [...ROBLOX_CDN_SUFFIXES],
      outbound: "direct"
    });
  } else {
    routeRules.push({
      domain_suffix: [...ROBLOX_CDN_SUFFIXES],
      outbound: "global-exit"
    });
  }

  routeRules.push({
    domain_suffix: [...ROBLOX_GLOBAL_API_SUFFIXES],
    outbound: "global-exit"
  });

  return {
    log: {
      level: "info",
      timestamp: true
    },
    dns: {
      servers: [
        {
          tag: "dns-global",
          address: "tcp://1.1.1.1",
          strategy: "ipv4_only",
          detour: "global-exit"
        },
        {
          tag: "dns-direct",
          address: "1.1.1.1",
          strategy: "ipv4_only",
          detour: "direct"
        }
      ],
      rules: [
        {
          domain_suffix: [...ROBLOX_GLOBAL_API_SUFFIXES],
          server: "dns-global"
        }
      ],
      final: "dns-direct"
    },
    inbounds,
    outbounds: [
      globalOutbound,
      {
        type: "direct",
        tag: "direct"
      },
      {
        type: "block",
        tag: "block"
      },
      {
        type: "dns",
        tag: "dns-out"
      }
    ],
    route: {
      rules: routeRules,
      final: "direct",
      auto_detect_interface: true
    }
  };
}
