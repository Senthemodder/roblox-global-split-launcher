import fs from "node:fs";
import path from "node:path";
import { SplitTunnelSettings, UpstreamTunnelConfig } from "./types.js";
import { provisionCloudflareWarpTunnel } from "./proxy/warp-provisioner.js";

export const DEFAULT_SETTINGS: SplitTunnelSettings = {
  listenHost: "127.0.0.1",
  listenPort: 7899,
  routeRbxCdnDirect: true,
  blockVngRedirects: true,
  autoConfigureWindowsPac: true,
  activeUpstreamId: null,
  upstreams: []
};

export class ConfigStore {
  private readonly filePath: string;
  private settings: SplitTunnelSettings;

  constructor(customFilePath?: string) {
    this.filePath =
      customFilePath || path.join(process.cwd(), ".runtime", "split-tunnel-settings.json");
    this.settings = this.loadFromDisk();
  }

  private loadFromDisk(): SplitTunnelSettings {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf8");
        const parsed = JSON.parse(raw) as Partial<SplitTunnelSettings>;
        return {
          ...DEFAULT_SETTINGS,
          ...parsed,
          upstreams: Array.isArray(parsed.upstreams) ? parsed.upstreams : []
        };
      }
    } catch {
      // Fall back to default settings if corrupted
    }
    return { ...DEFAULT_SETTINGS, upstreams: [] };
  }

  public saveToDisk(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2), "utf8");
  }

  public getSettings(): SplitTunnelSettings {
    return this.settings;
  }

  public updateSettings(patch: Partial<SplitTunnelSettings>): SplitTunnelSettings {
    this.settings = {
      ...this.settings,
      ...patch
    };
    this.saveToDisk();
    return this.settings;
  }

  public addUpstream(upstream: UpstreamTunnelConfig, setActive = true): SplitTunnelSettings {
    const existingIdx = this.settings.upstreams.findIndex((u) => u.id === upstream.id);
    if (existingIdx !== -1) {
      this.settings.upstreams[existingIdx] = upstream;
    } else {
      this.settings.upstreams.push(upstream);
    }
    if (setActive || !this.settings.activeUpstreamId) {
      this.settings.activeUpstreamId = upstream.id;
    }
    this.saveToDisk();
    return this.settings;
  }

  public removeUpstream(id: string): SplitTunnelSettings {
    this.settings.upstreams = this.settings.upstreams.filter((u) => u.id !== id);
    if (this.settings.activeUpstreamId === id) {
      this.settings.activeUpstreamId =
        this.settings.upstreams.length > 0 ? this.settings.upstreams[0].id : null;
    }
    this.saveToDisk();
    return this.settings;
  }

  /**
   * Automatically provisions a free Cloudflare WARP WireGuard upstream tunnel and activates it
   * if no upstream tunnel is currently configured ("wire it by default").
   */
  public async ensureDefaultWiredUpstream(): Promise<UpstreamTunnelConfig> {
    const active = this.settings.upstreams.find(
      (u) => u.id === this.settings.activeUpstreamId
    );
    if (active) {
      return active;
    }
    if (this.settings.upstreams.length > 0) {
      this.settings.activeUpstreamId = this.settings.upstreams[0].id;
      this.saveToDisk();
      return this.settings.upstreams[0];
    }

    const warpTunnel = await provisionCloudflareWarpTunnel();
    this.addUpstream(warpTunnel, true);
    return warpTunnel;
  }
}
