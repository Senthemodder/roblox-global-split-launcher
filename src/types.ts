export type TunnelProtocol = "socks5" | "http" | "wireguard" | "vless" | "shadowsocks";

export interface BaseTunnelConfig {
  id: string;
  name: string;
  protocol: TunnelProtocol;
  server: string;
  serverPort: number;
}

export interface Socks5TunnelConfig extends BaseTunnelConfig {
  protocol: "socks5";
  username?: string;
  password?: string;
}

export interface HttpTunnelConfig extends BaseTunnelConfig {
  protocol: "http";
  tls?: boolean;
  username?: string;
  password?: string;
}

export interface WireGuardTunnelConfig extends BaseTunnelConfig {
  protocol: "wireguard";
  localAddress: string[];
  privateKey: string;
  peerPublicKey: string;
  presharedKey?: string;
  reserved?: [number, number, number];
  mtu?: number;
}

export interface VlessTunnelConfig extends BaseTunnelConfig {
  protocol: "vless";
  uuid: string;
  flow?: string;
  tls: boolean;
  serverName?: string;
  realityPublicKey?: string;
  realityShortId?: string;
  transportType?: "tcp" | "ws" | "grpc";
  transportPath?: string;
}

export interface ShadowsocksTunnelConfig extends BaseTunnelConfig {
  protocol: "shadowsocks";
  method: string;
  password: string;
}

export type UpstreamTunnelConfig =
  | Socks5TunnelConfig
  | HttpTunnelConfig
  | WireGuardTunnelConfig
  | VlessTunnelConfig
  | ShadowsocksTunnelConfig;

export type RouteDecision = "GLOBAL_TUNNEL" | "DIRECT_ISP" | "BLOCK_VNG_TELEMETRY";

export interface SplitRouteEvent {
  id: number;
  timestamp: string;
  hostname: string;
  port: number;
  transport: "TCP" | "UDP" | "HTTP";
  decision: RouteDecision;
  reason: string;
  upstreamName?: string;
}

export interface SplitTunnelSettings {
  listenHost: string;
  listenPort: number;
  routeRbxCdnDirect: boolean;
  blockVngRedirects: boolean;
  autoConfigureWindowsPac: boolean;
  activeUpstreamId: string | null;
  upstreams: UpstreamTunnelConfig[];
}

export interface GlobalVersionInfo {
  version: string;
  clientVersionUpload: string;
  bootstrapperVersion: string;
}

export interface PackageManifestEntry {
  fileName: string;
  md5: string;
  compressedSize: number;
  uncompressedSize: number;
  extractFolder: string;
}

export interface RobloxInstallationInfo {
  globalInstalled: boolean;
  globalExecutablePath: string | null;
  installedVersionUpload: string | null;
  vngDetected: boolean;
  vngPaths: string[];
  versionsDirectory: string;
}

export interface CatalogItem {
  id: number;
  itemType: string;
  name: string;
  description: string;
  price?: number;
  priceStatus?: string;
  creatorName: string;
  creatorType: string;
  productId?: number;
  itemStatus?: string[];
  itemRestrictions?: string[];
  thumbnailUrl?: string;
}

export interface RegionStatusReport {
  directIp: string;
  directCountryCode: string;
  directIsp: string;
  proxiedIp: string | null;
  proxiedCountryCode: string | null;
  proxiedIsp: string | null;
  robloxDetectedCountryCode: string | null;
  vngRiskLevel: "SAFE_GLOBAL" | "VNG_LOCK_RISK" | "UPSTREAM_UNCONFIGURED";
  summary: string;
}
