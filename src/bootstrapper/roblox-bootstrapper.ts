import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import https from "node:https";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import AdmZip from "adm-zip";
import {
  GlobalVersionInfo,
  PackageManifestEntry,
  RobloxInstallationInfo
} from "../types.js";

const execFileAsync = promisify(execFile);

export const SETUP_CDN_BASE = "https://setup.rbxcdn.com";
export const CLIENT_SETTINGS_ENDPOINTS = [
  "https://clientsettingscdn.roblox.com/v2/client-version/WindowsPlayer",
  "https://clientsettings.roblox.com/v2/client-version/WindowsPlayer"
];

/**
 * Exact directory mapping used by the official Roblox WindowsPlayer bootstrapper
 * when extracting packages listed in rbxPkgManifest.txt.
 */
export const PACKAGE_EXTRACT_MAP: Record<string, string> = {
  "RobloxApp.zip": "",
  "redist.zip": "",
  "shaders.zip": "shaders",
  "ssl.zip": "ssl",
  "WebView2.zip": "",
  "WebView2RuntimeInstaller.zip": "WebView2RuntimeInstaller",
  "content-avatar.zip": "content/avatar",
  "content-configs.zip": "content/configs",
  "content-fonts.zip": "content/fonts",
  "content-sky.zip": "content/sky",
  "content-sounds.zip": "content/sounds",
  "content-textures2.zip": "content/textures",
  "content-models.zip": "content/models",
  "content-textures3.zip": "PlatformContent/pc/textures",
  "content-terrain.zip": "PlatformContent/pc/terrain",
  "content-platform-fonts.zip": "PlatformContent/pc/fonts",
  "content-platform-dictionaries.zip": "PlatformContent/pc/shared_compression_dictionaries",
  "Extracontent-luapackages.zip": "ExtraContent/LuaPackages",
  "Extracontent-translations.zip": "ExtraContent/translations",
  "Extracontent-models.zip": "ExtraContent/models",
  "Extracontent-textures.zip": "ExtraContent/textures",
  "Extracontent-places.zip": "ExtraContent/places"
};

function httpsGetBuffer(url: string, timeoutMs = 20000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "Roblox/WinInet",
          Accept: "*/*"
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
          httpsGetBuffer(res.headers.location, timeoutMs).then(resolve).catch(reject);
          res.resume();
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} when fetching ${url}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error(`Request timed out for ${url}`));
    });
    req.on("error", reject);
  });
}

/**
 * Queries Roblox's official ClientSettings API for the current Global WindowsPlayer version.
 */
export async function fetchGlobalWindowsPlayerVersion(): Promise<GlobalVersionInfo> {
  let lastError: Error | null = null;
  for (const endpoint of CLIENT_SETTINGS_ENDPOINTS) {
    try {
      const buf = await httpsGetBuffer(endpoint, 12000);
      const parsed = JSON.parse(buf.toString("utf8")) as Partial<GlobalVersionInfo>;
      if (parsed.clientVersionUpload && parsed.version) {
        return {
          version: parsed.version,
          clientVersionUpload: parsed.clientVersionUpload,
          bootstrapperVersion: parsed.bootstrapperVersion || "1, 0, 0, 0"
        };
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError || new Error("Unable to fetch Global WindowsPlayer version");
}

/**
 * Parses a raw rbxPkgManifest.txt file from setup.rbxcdn.com into structured entries.
 */
export function parsePackageManifest(manifestText: string): PackageManifestEntry[] {
  const lines = manifestText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0 || lines[0] !== "v0") {
    throw new Error(`Unexpected rbxPkgManifest format header: ${lines[0] || "empty"}`);
  }

  const entries: PackageManifestEntry[] = [];
  for (let i = 1; i + 3 < lines.length; i += 4) {
    const fileName = lines[i];
    const md5 = lines[i + 1];
    const compressedSize = Number.parseInt(lines[i + 2], 10);
    const uncompressedSize = Number.parseInt(lines[i + 3], 10);
    const extractFolder = PACKAGE_EXTRACT_MAP[fileName] ?? "";

    entries.push({
      fileName,
      md5,
      compressedSize,
      uncompressedSize,
      extractFolder
    });
  }
  return entries;
}

/**
 * Fetches and parses https://setup.rbxcdn.com/<versionUpload>-rbxPkgManifest.txt
 */
export async function fetchPackageManifest(
  clientVersionUpload: string
): Promise<PackageManifestEntry[]> {
  const url = `${SETUP_CDN_BASE}/${clientVersionUpload}-rbxPkgManifest.txt`;
  const buf = await httpsGetBuffer(url, 15000);
  return parsePackageManifest(buf.toString("utf8"));
}

export function getRobloxVersionsDir(): string {
  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "Roblox", "Versions");
}

/**
 * Scans the local Windows machine for installed Global RobloxPlayerBeta.exe versions
 * and checks for any Roblox VNG client installations that could conflict.
 */
export function detectLocalInstallations(): RobloxInstallationInfo {
  const versionsDirectory = getRobloxVersionsDir();
  let globalExecutablePath: string | null = null;
  let installedVersionUpload: string | null = null;
  let latestMtime = 0;

  if (fs.existsSync(versionsDirectory)) {
    const entries = fs.readdirSync(versionsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidateExe = path.join(versionsDirectory, entry.name, "RobloxPlayerBeta.exe");
      if (fs.existsSync(candidateExe)) {
        const stat = fs.statSync(candidateExe);
        if (stat.mtimeMs >= latestMtime) {
          latestMtime = stat.mtimeMs;
          globalExecutablePath = candidateExe;
          installedVersionUpload = entry.name;
        }
      }
    }
  }

  // Also check Bloxstrap versions folder if standard Roblox folder wasn't found
  if (!globalExecutablePath) {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const bloxstrapVersions = path.join(localAppData, "Bloxstrap", "Versions");
    if (fs.existsSync(bloxstrapVersions)) {
      const entries = fs.readdirSync(bloxstrapVersions, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const candidateExe = path.join(bloxstrapVersions, entry.name, "RobloxPlayerBeta.exe");
        if (fs.existsSync(candidateExe)) {
          globalExecutablePath = candidateExe;
          installedVersionUpload = entry.name;
          break;
        }
      }
    }
  }

  // Check for VNG paths
  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const candidateVngDirs = [
    path.join(localAppData, "RobloxVNG"),
    path.join(localAppData, "VNGGames", "Roblox"),
    path.join(localAppData, "Programs", "Roblox-VNG")
  ];
  const vngPaths = candidateVngDirs.filter((p) => fs.existsSync(p));

  return {
    globalInstalled: Boolean(globalExecutablePath),
    globalExecutablePath,
    installedVersionUpload,
    vngDetected: vngPaths.length > 0,
    vngPaths,
    versionsDirectory
  };
}

export function generateAppSettingsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Settings>",
    "\t<ContentFolder>content</ContentFolder>",
    "\t<BaseUrl>http://www.roblox.com</BaseUrl>",
    "</Settings>"
  ].join("\r\n");
}

export interface InstallProgress {
  phase: "manifest" | "downloading" | "extracting" | "configuring" | "complete";
  currentPackage?: string;
  completedPackages: number;
  totalPackages: number;
}

/**
 * Downloads and installs the official Global Roblox WindowsPlayer directly from
 * setup.rbxcdn.com (bypassing the roblox.com regional VNG web installer redirect).
 */
export async function installGlobalRobloxClient(
  clientVersionUpload: string,
  targetRootDir?: string,
  onProgress?: (progress: InstallProgress) => void
): Promise<string> {
  const versionsRoot = targetRootDir || getRobloxVersionsDir();
  const versionDir = path.join(versionsRoot, clientVersionUpload);
  fs.mkdirSync(versionDir, { recursive: true });

  onProgress?.({
    phase: "manifest",
    completedPackages: 0,
    totalPackages: 1
  });

  const manifest = await fetchPackageManifest(clientVersionUpload);
  const zipEntries = manifest.filter((m) => m.fileName.endsWith(".zip"));

  for (let i = 0; i < zipEntries.length; i++) {
    const pkg = zipEntries[i];
    onProgress?.({
      phase: "downloading",
      currentPackage: pkg.fileName,
      completedPackages: i,
      totalPackages: zipEntries.length
    });

    const pkgUrl = `${SETUP_CDN_BASE}/${clientVersionUpload}-${pkg.fileName}`;
    const zipBuffer = await httpsGetBuffer(pkgUrl, 120000);

    const actualMd5 = crypto.createHash("md5").update(zipBuffer).digest("hex").toLowerCase();
    if (pkg.md5 && actualMd5 !== pkg.md5.toLowerCase()) {
      throw new Error(
        `MD5 mismatch for ${pkg.fileName}: expected ${pkg.md5}, got ${actualMd5}`
      );
    }

    onProgress?.({
      phase: "extracting",
      currentPackage: pkg.fileName,
      completedPackages: i,
      totalPackages: zipEntries.length
    });

    const extractDest = pkg.extractFolder
      ? path.join(versionDir, pkg.extractFolder)
      : versionDir;
    fs.mkdirSync(extractDest, { recursive: true });

    const zip = new AdmZip(zipBuffer);
    zip.extractAllTo(extractDest, true);
  }

  onProgress?.({
    phase: "configuring",
    completedPackages: zipEntries.length,
    totalPackages: zipEntries.length
  });

  const appSettingsPath = path.join(versionDir, "AppSettings.xml");
  fs.writeFileSync(appSettingsPath, generateAppSettingsXml(), "utf8");

  const exePath = path.join(versionDir, "RobloxPlayerBeta.exe");
  if (process.platform === "win32" && fs.existsSync(exePath)) {
    await registerGlobalRobloxProtocol(exePath);
  }

  onProgress?.({
    phase: "complete",
    completedPackages: zipEntries.length,
    totalPackages: zipEntries.length
  });

  return exePath;
}

/**
 * Downloads the standalone official Global RobloxPlayerLauncher.exe directly from setup.rbxcdn.com
 * into the specified directory and runs it if a fast lightweight bootstrapper install is requested.
 */
export async function downloadGlobalBootstrapperExe(
  clientVersionUpload: string,
  destFolder: string
): Promise<string> {
  fs.mkdirSync(destFolder, { recursive: true });
  const url = `${SETUP_CDN_BASE}/${clientVersionUpload}-Roblox.exe`;
  const buf = await httpsGetBuffer(url, 60000);
  const outPath = path.join(destFolder, `RobloxGlobalInstaller-${clientVersionUpload}.exe`);
  fs.writeFileSync(outPath, buf);
  return outPath;
}

/**
 * Registers the Windows `roblox-player:` URI protocol handler to always launch the
 * Global RobloxPlayerBeta.exe binary instead of any VNG client.
 */
export async function registerGlobalRobloxProtocol(exePath: string): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }
  const commandValue = `"${exePath}" %1`;
  await execFileAsync("reg.exe", [
    "add",
    "HKCU\\Software\\Classes\\roblox-player",
    "/ve",
    "/t",
    "REG_SZ",
    "/d",
    "URL: Roblox Protocol",
    "/f"
  ]);
  await execFileAsync("reg.exe", [
    "add",
    "HKCU\\Software\\Classes\\roblox-player",
    "/v",
    "URL Protocol",
    "/t",
    "REG_SZ",
    "/d",
    "",
    "/f"
  ]);
  await execFileAsync("reg.exe", [
    "add",
    "HKCU\\Software\\Classes\\roblox-player\\shell\\open\\command",
    "/ve",
    "/t",
    "REG_SZ",
    "/d",
    commandValue,
    "/f"
  ]);
}

export interface LaunchClientOptions {
  executablePath?: string;
  placeId?: string;
  protocolUri?: string;
}

/**
 * Launches the Global RobloxPlayerBeta.exe client in Desktop App mode (--app)
 * or directly into an experience URI.
 */
export function launchGlobalRobloxClient(options: LaunchClientOptions = {}): {
  pid: number | undefined;
  executablePath: string;
  args: string[];
} {
  const detected = detectLocalInstallations();
  const exePath = options.executablePath || detected.globalExecutablePath;
  if (!exePath || !fs.existsSync(exePath)) {
    throw new Error(
      "Global RobloxPlayerBeta.exe is not installed yet. Click 'Install Global Client' first."
    );
  }

  let args: string[] = ["--app"];
  if (options.protocolUri && options.protocolUri.startsWith("roblox-player:")) {
    args = [options.protocolUri];
  } else if (options.placeId && /^\d+$/.test(options.placeId.trim())) {
    const placeId = options.placeId.trim();
    const launchTime = Date.now();
    const browserTrackerId = Math.floor(100000000 + Math.random() * 900000000);
    const placeLauncherUrl = encodeURIComponent(
      `https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestGame&browserTrackerId=${browserTrackerId}&placeId=${placeId}&isPlayTogetherGame=false`
    );
    args = [
      `roblox-player:1+launchmode:play+gameinfo:+launchtime:${launchTime}+placelauncherurl:${placeLauncherUrl}+browsertrackerid:${browserTrackerId}+robloxLocale:en_us+gameLocale:en_us+channel:`
    ];
  }

  const child = spawn(exePath, args, {
    detached: true,
    stdio: "ignore",
    cwd: path.dirname(exePath)
  });
  child.unref();

  return {
    pid: child.pid,
    executablePath: exePath,
    args
  };
}
