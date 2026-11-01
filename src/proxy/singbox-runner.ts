import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import net from "node:net";
import { ChildProcess, spawn } from "node:child_process";
import AdmZip from "adm-zip";
import { generateSingBoxConfig } from "./singbox-config.js";
import { SplitTunnelSettings, UpstreamTunnelConfig } from "../types.js";

export const SINGBOX_VERSION = "1.10.7";
export const SINGBOX_RELEASE_URL = `https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VERSION}/sing-box-${SINGBOX_VERSION}-windows-amd64.zip`;
const MIN_VALID_SINGBOX_BYTES = 20_000_000;

function httpsDownloadBuffer(url: string, timeoutMs = 60000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "RobloxGlobalSplitLauncher/1.0"
        },
        timeout: timeoutMs
      },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          httpsDownloadBuffer(res.headers.location, timeoutMs).then(resolve).catch(reject);
          res.resume();
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Download timed out: ${url}`)));
    req.on("error", reject);
  });
}

export function getSingBoxBinaryPath(baseDir = process.cwd()): string {
  return path.join(baseDir, ".runtime", "bin", "sing-box.exe");
}

/**
 * Ensures the official sing-box.exe binary is present and intact (>20MB) in .runtime/bin/sing-box.exe,
 * downloading and atomically extracting it from GitHub Releases if missing or truncated.
 */
export async function ensureSingBoxBinary(baseDir = process.cwd()): Promise<string> {
  const exePath = getSingBoxBinaryPath(baseDir);
  if (fs.existsSync(exePath)) {
    try {
      const stat = fs.statSync(exePath);
      if (stat.size >= MIN_VALID_SINGBOX_BYTES) {
        return exePath;
      }
      fs.unlinkSync(exePath);
    } catch {
      // Proceed to re-download
    }
  }

  const binDir = path.dirname(exePath);
  fs.mkdirSync(binDir, { recursive: true });

  const zipBuf = await httpsDownloadBuffer(SINGBOX_RELEASE_URL, 90000);
  const zip = new AdmZip(zipBuf);
  const entries = zip.getEntries();
  const exeEntry = entries.find((e) => e.entryName.toLowerCase().endsWith("sing-box.exe"));
  if (!exeEntry) {
    throw new Error("sing-box.exe not found inside downloaded release archive");
  }

  const extractedData = exeEntry.getData();
  if (extractedData.length < MIN_VALID_SINGBOX_BYTES) {
    throw new Error(`Extracted sing-box.exe is unexpectedly small (${extractedData.length} bytes)`);
  }

  const tmpPath = `${exePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, extractedData);
  fs.renameSync(tmpPath, exePath);
  return exePath;
}

function waitForPortListening(host: string, port: number, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryConnect = (): void => {
      const sock = net.connect({ host, port });
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() - start >= timeoutMs) {
          reject(new Error(`Timed out waiting for sing-box bridge port ${host}:${port}`));
        } else {
          setTimeout(tryConnect, 150);
        }
      });
    };
    tryConnect();
  });
}

export class SingBoxBridgeRunner {
  private child: ChildProcess | null = null;
  private bridgePort: number;
  private readonly baseDir: string;
  private lastLogs: string[] = [];

  constructor(bridgePort = 7897, baseDir = process.cwd()) {
    this.bridgePort = bridgePort;
    this.baseDir = baseDir;
  }

  public getBridgePort(): number {
    return this.bridgePort;
  }

  public isRunning(): boolean {
    return this.child !== null && !this.child.killed;
  }

  public getRecentLogs(): string[] {
    return this.lastLogs.slice(-30);
  }

  public async startWithUpstream(
    upstream: UpstreamTunnelConfig,
    settings: SplitTunnelSettings
  ): Promise<number> {
    await this.stop();
    const exePath = await ensureSingBoxBinary(this.baseDir);

    const cfg = generateSingBoxConfig(
      upstream,
      {
        listenHost: "127.0.0.1",
        listenPort: this.bridgePort,
        routeRbxCdnDirect: settings.routeRbxCdnDirect,
        blockVngRedirects: settings.blockVngRedirects
      },
      false
    );
    cfg.route.final = "global-exit";

    const cfgPath = path.join(this.baseDir, ".runtime", "singbox-active.json");
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");

    const proc = spawn(exePath, ["run", "-c", cfgPath], {
      cwd: path.dirname(exePath),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    const recordOutput = (chunk: Buffer): void => {
      const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
      for (const l of lines) {
        this.lastLogs.push(l);
        if (this.lastLogs.length > 100) {
          this.lastLogs.shift();
        }
      }
    };

    proc.stdout?.on("data", recordOutput);
    proc.stderr?.on("data", recordOutput);
    proc.once("error", (err) => {
      this.lastLogs.push(`spawn error: ${err.message}`);
    });
    proc.once("exit", () => {
      if (this.child === proc) {
        this.child = null;
      }
    });

    this.child = proc;
    await waitForPortListening("127.0.0.1", this.bridgePort, 8000);
    return this.bridgePort;
  }

  public async stop(): Promise<void> {
    if (!this.child) {
      return;
    }
    const proc = this.child;
    this.child = null;
    try {
      proc.kill();
    } catch {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1500);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
