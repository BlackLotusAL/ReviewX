import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "../server/errors";
import type { ResolvedCommand } from "../server/process";

async function exists(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(/* turbopackIgnore: true */ filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

function pathEntries(environment: NodeJS.ProcessEnv): string[] {
  return (environment.PATH ?? environment.Path ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

async function resolveNativeExecutable(
  name: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | null> {
  const extensions = process.platform === "win32" ? [".exe", ".com"] : [""];
  for (const directory of pathEntries(environment)) {
    for (const extension of extensions) {
      const candidate = path.join(/* turbopackIgnore: true */ directory, `${name}${extension}`);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

async function resolvePowerShell(environment: NodeJS.ProcessEnv): Promise<string> {
  for (const name of ["pwsh", "powershell"]) {
    const executable = await resolveNativeExecutable(name, environment);
    if (executable) return executable;
  }
  const systemPowerShell = path.join(
    /* turbopackIgnore: true */
    environment.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (await exists(systemPowerShell)) return systemPowerShell;
  throw new AppError({
    code: "STARTUP_ERROR",
    message: "ReviewX 找不到 PowerShell。",
    reason: "npm CLI 的安全启动需要 PowerShell，但系统中未找到可执行文件。",
    impact: "Web 服务未启动。",
    nextStep: "安装 PowerShell 7 或修复 Windows PowerShell。",
    technical: "Neither pwsh.exe nor powershell.exe could be resolved.",
  });
}

export async function resolveCommand(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedCommand> {
  const native = await resolveNativeExecutable(name, environment);
  if (native) return { name, executable: native, prefixArgs: [] };

  if (process.platform === "win32") {
    for (const directory of pathEntries(environment)) {
      const script = path.join(/* turbopackIgnore: true */ directory, `${name}.ps1`);
      if (await exists(script)) {
        const powerShell = await resolvePowerShell(environment);
        return {
          name,
          executable: powerShell,
          prefixArgs: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
          ],
          powerShellScript: script,
        };
      }
    }
  }

  throw new AppError({
    code: "COMMAND_NOT_FOUND",
    message: `ReviewX 找不到外部命令 ${name}。`,
    reason: `${name} 未安装，未加入 PATH，或只有不安全的 .cmd 启动器。`,
    impact: "当前操作未执行。",
    nextStep: `安装并配置 ${name}，确认其 .exe 或 npm .ps1 启动器可用后重试。`,
    technical: `Unable to resolve executable or PowerShell shim for ${name}.`,
  });
}
