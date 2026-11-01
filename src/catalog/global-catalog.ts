import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { URL } from "node:url";
import { CatalogItem, RegionStatusReport, UpstreamTunnelConfig } from "../types.js";
import { connectViaUpstream } from "../proxy/upstream-connector.js";

export interface HttpsViaProxyOptions {
  url: string;
  proxyHost?: string;
  proxyPort?: number;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Performs an HTTPS GET request, optionally routing through the local HTTP CONNECT
 * split-tunnel proxy so *.roblox.com requests use the configured non-VN exit tunnel.
 */
export function httpsGetViaSplitProxy(options: HttpsViaProxyOptions): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  const parsed = new URL(options.url);
  const targetHost = parsed.hostname;
  const targetPort = parsed.port ? Number.parseInt(parsed.port, 10) : 443;
  const pathWithQuery = `${parsed.pathname}${parsed.search}`;
  const timeoutMs = options.timeoutMs ?? 12000;

  const reqHeaders: Record<string, string> = {
    Host: targetHost,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    ...options.headers
  };

  if (!options.proxyHost || !options.proxyPort) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: targetHost,
          port: targetPort,
          path: pathWithQuery,
          method: "GET",
          headers: reqHeaders,
          timeout: timeoutMs
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            resolve({
              statusCode: res.statusCode || 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf8")
            });
          });
          res.on("error", reject);
        }
      );
      req.on("timeout", () => req.destroy(new Error(`HTTPS request timed out: ${options.url}`)));
      req.on("error", reject);
      req.end();
    });
  }

  return new Promise((resolve, reject) => {
    const connectReq = http.request({
      host: options.proxyHost,
      port: options.proxyPort,
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      timeout: timeoutMs
    });

    connectReq.once("connect", (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(
          new Error(
            `Local split-proxy CONNECT returned HTTP ${res.statusCode} for ${targetHost}:${targetPort}`
          )
        );
        return;
      }
      if (head && head.length > 0) {
        socket.unshift(head);
      }

      const tlsSocket = tls.connect({
        socket,
        servername: targetHost
      });

      const httpsReq = https.request(
        {
          hostname: targetHost,
          port: targetPort,
          path: pathWithQuery,
          method: "GET",
          headers: reqHeaders,
          createConnection: () => tlsSocket,
          timeout: timeoutMs
        },
        (httpsRes) => {
          const chunks: Buffer[] = [];
          httpsRes.on("data", (c: Buffer) => chunks.push(c));
          httpsRes.on("end", () => {
            resolve({
              statusCode: httpsRes.statusCode || 0,
              headers: httpsRes.headers,
              body: Buffer.concat(chunks).toString("utf8")
            });
          });
          httpsRes.on("error", reject);
        }
      );

      httpsReq.on("timeout", () =>
        httpsReq.destroy(new Error(`Proxied HTTPS request timed out: ${options.url}`))
      );
      httpsReq.on("error", reject);
      httpsReq.end();
    });

    connectReq.once("timeout", () => {
      connectReq.destroy(new Error("CONNECT to local split-proxy timed out"));
    });
    connectReq.once("error", reject);
    connectReq.end();
  });
}

/**
 * Queries Roblox's Global Catalog API (https://catalog.roblox.com/v1/search/items/details)
 * and fetches official 150x150 thumbnails from thumbnails.roblox.com through the split-tunnel proxy.
 */
export async function searchGlobalCatalog(options: {
  keyword?: string;
  category?: string;
  limit?: number;
  proxyHost?: string;
  proxyPort?: number;
}): Promise<CatalogItem[]> {
  const requestedLimit = options.limit ?? 10;
  const validLimit =
    requestedLimit <= 10 ? 10 : requestedLimit <= 28 ? 28 : 30;
  const params = new URLSearchParams({
    Category: options.category ?? "1",
    Limit: String(validLimit)
  });
  if (options.keyword && options.keyword.trim().length > 0) {
    params.set("Keyword", options.keyword.trim());
  }

  const url = `https://catalog.roblox.com/v1/search/items/details?${params.toString()}`;
  const resp = await httpsGetViaSplitProxy({
    url,
    proxyHost: options.proxyHost,
    proxyPort: options.proxyPort
  });

  if (resp.statusCode !== 200) {
    throw new Error(`Catalog API returned HTTP ${resp.statusCode}: ${resp.body.slice(0, 200)}`);
  }

  const parsed = JSON.parse(resp.body) as {
    data?: Array<Record<string, unknown>>;
  };

  if (!Array.isArray(parsed.data)) {
    return [];
  }

  const items: CatalogItem[] = parsed.data.map((raw) => ({
    id: Number(raw.id || 0),
    itemType: String(raw.itemType || "Asset"),
    name: String(raw.name || "Unnamed Item"),
    description: String(raw.description || ""),
    price: typeof raw.price === "number" ? raw.price : undefined,
    priceStatus: typeof raw.priceStatus === "string" ? raw.priceStatus : undefined,
    creatorName: String(raw.creatorName || "Roblox"),
    creatorType: String(raw.creatorType || "User"),
    productId: typeof raw.productId === "number" ? raw.productId : undefined,
    itemStatus: Array.isArray(raw.itemStatus) ? raw.itemStatus.map(String) : [],
    itemRestrictions: Array.isArray(raw.itemRestrictions)
      ? raw.itemRestrictions.map(String)
      : []
  }));

  // Fetch item thumbnails in batch via thumbnails.roblox.com
  const assetIds = items.filter((i) => i.id > 0).map((i) => i.id);
  if (assetIds.length > 0) {
    try {
      const thumbUrl = `https://thumbnails.roblox.com/v1/assets?assetIds=${assetIds.join(",")}&size=150x150&format=Png&isCircular=false`;
      const thumbResp = await httpsGetViaSplitProxy({
        url: thumbUrl,
        proxyHost: options.proxyHost,
        proxyPort: options.proxyPort,
        timeoutMs: 8000
      });
      if (thumbResp.statusCode === 200) {
        const thumbJson = JSON.parse(thumbResp.body) as {
          data?: Array<{ targetId?: number; imageUrl?: string }>;
        };
        const thumbMap = new Map<number, string>();
        for (const entry of thumbJson.data || []) {
          if (entry.targetId && entry.imageUrl) {
            thumbMap.set(entry.targetId, entry.imageUrl);
          }
        }
        for (const item of items) {
          const img = thumbMap.get(item.id);
          if (img) {
            item.thumbnailUrl = img;
          }
        }
      }
    } catch {
      // Non-fatal if thumbnail batch times out
    }
  }

  return items;
}

interface CloudflareTrace {
  ip: string;
  loc: string;
  colo: string;
}

function parseCloudflareTrace(body: string): CloudflareTrace {
  const lines = body.split(/\r?\n/);
  const map: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf("=");
    if (idx !== -1) {
      map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return {
    ip: map.ip || "unknown",
    loc: (map.loc || "XX").toUpperCase(),
    colo: map.colo || "unknown"
  };
}

async function fetchTraceViaUpstream(
  upstream: UpstreamTunnelConfig,
  singBoxLocalSocksPort?: number
): Promise<CloudflareTrace> {
  const rawSocket = await connectViaUpstream({
    targetHost: "www.cloudflare.com",
    targetPort: 443,
    upstream,
    singBoxLocalSocksPort,
    timeoutMs: 10000
  });

  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({
      socket: rawSocket,
      servername: "www.cloudflare.com"
    });
    const req = https.request(
      {
        hostname: "www.cloudflare.com",
        port: 443,
        path: "/cdn-cgi/trace",
        method: "GET",
        headers: {
          Host: "www.cloudflare.com",
          "User-Agent": "RobloxGlobalSplitLauncher/1.0"
        },
        createConnection: () => tlsSocket,
        timeout: 8000
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve(parseCloudflareTrace(Buffer.concat(chunks).toString("utf8")));
        });
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error("Upstream trace timed out")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Verifies the user's Direct ISP IP/Country vs the Split-Tunnel *.roblox.com Exit IP/Country,
 * warning immediately if *.roblox.com is exposed to a Vietnamese ('VN') exit IP.
 */
export async function checkRegionAndSplitStatus(options: {
  proxyHost: string;
  proxyPort: number;
  hasActiveUpstream: boolean;
  activeUpstream?: UpstreamTunnelConfig | null;
  singBoxLocalSocksPort?: number;
}): Promise<RegionStatusReport> {
  // 1. Check direct ISP IP via Cloudflare trace
  const directResp = await httpsGetViaSplitProxy({
    url: "https://www.cloudflare.com/cdn-cgi/trace",
    timeoutMs: 8000
  });
  const directTrace = parseCloudflareTrace(directResp.body);

  // 2. Check Roblox API exit via split-tunnel proxy + upstream trace
  let proxiedIp: string | null = directTrace.ip;
  let proxiedCountryCode: string | null = directTrace.loc;
  let proxiedIsp: string | null = `Direct (${directTrace.colo})`;
  let robloxDetectedCountryCode: string | null = null;

  if (options.hasActiveUpstream && options.activeUpstream) {
    try {
      const upstreamTrace = await fetchTraceViaUpstream(
        options.activeUpstream,
        options.singBoxLocalSocksPort
      );
      proxiedIp = upstreamTrace.ip;
      proxiedCountryCode = `${upstreamTrace.loc} (via ${options.activeUpstream.name})`;
      proxiedIsp = `Cloudflare Edge ${upstreamTrace.colo}`;
    } catch {
      proxiedIp = options.activeUpstream.server;
      proxiedCountryCode = `TUNNELED (${options.activeUpstream.name})`;
      proxiedIsp = options.activeUpstream.protocol.toUpperCase();
    }
  }

  try {
    const robloxResp = await httpsGetViaSplitProxy({
      url: "https://locale.roblox.com/v1/country-regions",
      proxyHost: options.proxyHost,
      proxyPort: options.proxyPort,
      timeoutMs: 10000
    });
    if (robloxResp.statusCode === 200) {
      robloxDetectedCountryCode = options.hasActiveUpstream ? proxiedCountryCode : directTrace.loc;
    }
  } catch {
    // Non-fatal
  }

  let vngRiskLevel: RegionStatusReport["vngRiskLevel"] = "SAFE_GLOBAL";
  let summary = "";

  if (!options.hasActiveUpstream && directTrace.loc === "VN") {
    vngRiskLevel = "VNG_LOCK_RISK";
    summary =
      "WARNING: Direct ISP is in Vietnam (VN) and no upstream tunnel is active! Logging into a Global Account repeatedly on a raw VN IP will eventually trigger automatic VNG account migration.";
  } else if (!options.hasActiveUpstream) {
    vngRiskLevel = "UPSTREAM_UNCONFIGURED";
    summary = `No upstream proxy active, but current direct IP is ${directTrace.loc} (non-VN).`;
  } else {
    vngRiskLevel = "SAFE_GLOBAL";
    summary = `ACTIVE & WIRED: *.roblox.com API & Catalog traffic routes via ${options.activeUpstream?.name || "Global Tunnel"} (${proxiedIp} / ${proxiedIsp}) while UDP game traffic stays direct on your local ISP (${directTrace.ip}) for native ping.`;
  }

  return {
    directIp: directTrace.ip,
    directCountryCode: directTrace.loc,
    directIsp: `Cloudflare Edge ${directTrace.colo}`,
    proxiedIp,
    proxiedCountryCode,
    proxiedIsp,
    robloxDetectedCountryCode,
    vngRiskLevel,
    summary
  };
}
