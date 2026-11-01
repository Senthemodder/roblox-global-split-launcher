import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import AdmZip from "adm-zip";
import { ConfigStore } from "../config-store.js";
import { ensureSingBoxBinary } from "../proxy/singbox-runner.js";

const execFileAsync = promisify(execFile);

const CSC_PATH = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";

export interface BuildReleaseResult {
  launcherExePath: string;
  portableZipPath: string;
  portableZipBytes: number;
  installerExePath: string;
  installerExeBytes: number;
}

export async function buildReleaseArtifacts(rootDir = process.cwd()): Promise<BuildReleaseResult> {
  if (!fs.existsSync(CSC_PATH)) {
    throw new Error(`C# compiler not found at ${CSC_PATH}`);
  }

  // 1. Ensure default-wired WARP config and sing-box.exe binary are ready
  const store = new ConfigStore(
    path.join(rootDir, ".runtime", "split-tunnel-settings.json")
  );
  await store.ensureDefaultWiredUpstream();
  const singBoxPath = await ensureSingBoxBinary(rootDir);

  const releaseDir = path.join(rootDir, "release");
  fs.mkdirSync(releaseDir, { recursive: true });

  // 2. Compile RobloxGlobalLauncher.exe
  const launcherCs = path.join(rootDir, "native", "RobloxGlobalLauncher.cs");
  const launcherExePath = path.join(rootDir, "RobloxGlobalLauncher.exe");

  await execFileAsync(CSC_PATH, [
    "/nologo",
    "/target:winexe",
    `/out:${launcherExePath}`,
    "/r:System.dll",
    "/r:System.Drawing.dll",
    "/r:System.Windows.Forms.dll",
    launcherCs
  ]);

  // 3. Create Start-RobloxGlobalSplit.bat convenience launcher
  const batPath = path.join(rootDir, "Start-RobloxGlobalSplit.bat");
  fs.writeFileSync(
    batPath,
    "@echo off\r\nstart \"\" \"%~dp0RobloxGlobalLauncher.exe\"\r\n",
    "utf8"
  );

  // 4. Build the Portable Release ZIP (containing RobloxGlobalLauncher.exe, dist/, node_modules/, .runtime/)
  const portableZipPath = path.join(
    releaseDir,
    "RobloxGlobalSplitLauncher-v1.0.0-win-x64.zip"
  );

  const zip = new AdmZip();
  zip.addLocalFile(launcherExePath);
  zip.addLocalFile(batPath);
  zip.addLocalFile(path.join(rootDir, "package.json"));
  if (fs.existsSync(path.join(rootDir, "README.md"))) {
    zip.addLocalFile(path.join(rootDir, "README.md"));
  }
  zip.addLocalFolder(path.join(rootDir, "dist"), "dist");
  zip.addLocalFolder(path.join(rootDir, "node_modules"), "node_modules");
  zip.addLocalFile(singBoxPath, ".runtime/bin");
  zip.addLocalFile(
    path.join(rootDir, ".runtime", "split-tunnel-settings.json"),
    ".runtime"
  );

  zip.writeZip(portableZipPath);
  const portableZipBytes = fs.statSync(portableZipPath).size;

  // 5. Compile RobloxGlobalSplitSetup.exe with the portable ZIP embedded as a manifest resource
  const setupCs = path.join(rootDir, "native", "RobloxGlobalSplitSetup.cs");
  const installerExePath = path.join(releaseDir, "RobloxGlobalSplitSetup.exe");

  await execFileAsync(CSC_PATH, [
    "/nologo",
    "/target:winexe",
    `/out:${installerExePath}`,
    "/r:System.dll",
    "/r:System.Drawing.dll",
    "/r:System.Windows.Forms.dll",
    "/r:System.IO.Compression.dll",
    "/r:System.IO.Compression.FileSystem.dll",
    `/resource:${portableZipPath},RobloxGlobalSplit.payload.zip`,
    setupCs
  ]);

  const installerExeBytes = fs.statSync(installerExePath).size;

  return {
    launcherExePath,
    portableZipPath,
    portableZipBytes,
    installerExePath,
    installerExeBytes
  };
}
