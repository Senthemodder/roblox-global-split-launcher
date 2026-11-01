import crypto from "node:crypto";
import https from "node:https";
import { WireGuardTunnelConfig } from "../types.js";

export interface WarpKeyPair {
  privateKeyBase64: string;
  publicKeyBase64: string;
}

/**
 * Generates a raw 32-byte Curve25519 (X25519) WireGuard keypair using Node's native crypto module.
 */
export function generateWireGuardKeyPair(): WarpKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const privDer = privateKey.export({ type: "pkcs8", format: "der" });
  const pubDer = publicKey.export({ type: "spki", format: "der" });

  // Raw 32-byte key sits at the end of the ASN.1 DER structure
  const rawPriv = privDer.subarray(privDer.length - 32);
  const rawPub = pubDer.subarray(pubDer.length - 32);

  return {
    privateKeyBase64: rawPriv.toString("base64"),
    publicKeyBase64: rawPub.toString("base64")
  };
}

interface CloudflareRegResponse {
  id?: string;
  client_id?: string;
  config?: {
    client_id?: string;
    interface?: {
      addresses?: {
        v4?: string;
        v6?: string;
      };
    };
    peers?: Array<{
      public_key?: string;
      endpoint?: {
        host?: string;
        v4?: string;
        ports?: number[];
      };
    }>;
  };
}

function postJson<T>(url: string, payload: unknown, timeoutMs = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(JSON.stringify(payload), "utf8");
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "User-Agent": "okhttp/3.12.1",
          "CF-Client-Version": "a-6.10-2158",
          Accept: "application/json",
          "Content-Length": bodyBuf.length
        },
        timeout: timeoutMs
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(
              new Error(`Cloudflare WARP API returned HTTP ${res.statusCode}: ${text.slice(0, 200)}`)
            );
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch (err) {
            reject(err);
          }
        });
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error("Cloudflare WARP registration timed out")));
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

/**
 * Automatically registers a free Cloudflare WARP WireGuard identity and returns
 * a complete WireGuardTunnelConfig ready for sing-box.
 */
export async function provisionCloudflareWarpTunnel(
  customName = "Cloudflare WARP Global (Auto-Provisioned)"
): Promise<WireGuardTunnelConfig> {
  const keys = generateWireGuardKeyPair();
  const regPayload = {
    key: keys.publicKeyBase64,
    install_id: "",
    fcm_token: "",
    tos: new Date().toISOString(),
    model: "PC",
    type: "Android",
    locale: "en_US"
  };

  const resp = await postJson<CloudflareRegResponse>(
    "https://api.cloudflareclient.com/v0a2158/reg",
    regPayload
  );

  const rawResult = (resp as unknown as { result?: CloudflareRegResponse }).result ?? resp;
  const cfg = rawResult.config;
  const v4Addr = cfg?.interface?.addresses?.v4 || "172.16.0.2";
  const localAddress = [
    v4Addr.includes("/") ? v4Addr : `${v4Addr}/32`
  ];

  const peer = cfg?.peers?.[0];
  const peerPublicKey =
    peer?.public_key || "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=";
  const endpointHostRaw = peer?.endpoint?.v4 || peer?.endpoint?.host || "162.159.192.1:2408";
  const cleanHost = endpointHostRaw.split(":")[0] || "162.159.192.1";

  const clientIdB64 = cfg?.client_id || rawResult.client_id || "";
  let reserved: [number, number, number] | undefined;
  if (clientIdB64) {
    const decoded = Buffer.from(clientIdB64, "base64");
    if (decoded.length >= 3) {
      reserved = [decoded[0], decoded[1], decoded[2]];
    }
  }

  return {
    id: "warp-default-auto",
    name: customName,
    protocol: "wireguard",
    server: cleanHost,
    serverPort: 2408,
    localAddress,
    privateKey: keys.privateKeyBase64,
    peerPublicKey,
    reserved,
    mtu: 1280
  };
}
