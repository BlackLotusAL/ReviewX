import fs from "node:fs";
import path from "node:path";
import { AppError } from "./errors";

export interface DataPaths {
  root: string;
  stateFile: string;
  stateLockFile: string;
  instanceLockFile: string;
  reports: string;
  logs: string;
  workspaces: string;
}

export function resolveDataPaths(environment: Readonly<Record<string, string | undefined>> = process.env): DataPaths {
  const localAppData = environment.LOCALAPPDATA?.trim();
  if (!localAppData) {
    throw new AppError({
      code: "DATA_DIRECTORY_ERROR",
      message: "ReviewX 无法确定本地数据目录。",
      reason: "Windows LOCALAPPDATA 环境变量为空。",
      impact: "Web 服务未启动。",
      nextStep: "修复当前 Windows 用户配置后重新运行 reviewx。",
      technical: "LOCALAPPDATA is missing.",
    });
  }
  const root = path.resolve(localAppData, "ReviewX");
  return {
    root,
    stateFile: path.join(root, "state.json"),
    stateLockFile: path.join(root, "state.lock"),
    instanceLockFile: path.join(root, "instance.lock"),
    reports: path.join(root, "reports"),
    logs: path.join(root, "logs"),
    workspaces: path.join(root, "workspaces"),
  };
}

export function ensureDataPaths(paths: DataPaths): void {
  try {
    for (const directory of [paths.root, paths.reports, paths.logs, paths.workspaces]) {
      fs.mkdirSync(directory, { recursive: true });
    }
  } catch (error) {
    throw new AppError({
      code: "DATA_DIRECTORY_ERROR",
      message: "ReviewX 无法创建本地数据目录。",
      reason: "数据目录不存在或当前用户没有写入权限。",
      impact: "Web 服务未启动。",
      nextStep: "检查 LOCALAPPDATA 下 ReviewX 目录权限后重试。",
      technical: error instanceof Error ? error.message : String(error),
      cause: error,
    });
  }
}
