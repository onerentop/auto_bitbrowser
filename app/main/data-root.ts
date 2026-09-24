/**
 * 数据根目录（accounts.db / config.json 所在处）—— 纯函数，不依赖 electron
 *
 * 路径规则：
 *   - 源码运行：项目根目录
 *   - 打包运行（frozen）：可执行文件所在目录
 * 另外支持环境变量 ABB_DATA_ROOT 覆盖——开发验证时指向临时目录，避免碰真实数据。
 */
import { dirname, resolve } from "node:path";

export interface DataRootInput {
  env: Record<string, string | undefined>;
  isPackaged: boolean;
  /** process.execPath */
  exePath: string;
  /** app.getAppPath()：开发时是仓库根（package.json 所在目录） */
  appPath: string;
}

export function resolveDataRoot(input: DataRootInput): string {
  const override = input.env["ABB_DATA_ROOT"]?.trim();
  if (override) return resolve(override);
  if (input.isPackaged) return dirname(input.exePath);
  // 开发时 appPath 就是仓库根（package.json 所在目录）
  return resolve(input.appPath);
}
