/**
 * 数据根目录（accounts.db / config.json 所在处）—— 纯函数，不依赖 electron
 *
 * 对标 Python 的路径规则（services/database.py:16-18、core/config_manager.py:13-23）：
 *   - 源码运行：项目根目录（与 Python 共用同一份数据）
 *   - 打包运行（frozen）：可执行文件所在目录
 * 另外支持环境变量 ABB_DATA_ROOT 覆盖——开发验证时指向临时目录，避免碰真实数据。
 */
import { dirname, resolve } from "node:path";

export interface DataRootInput {
  env: Record<string, string | undefined>;
  isPackaged: boolean;
  /** process.execPath */
  exePath: string;
  /** app.getAppPath()：开发时是 desktop/（package.json 所在目录） */
  appPath: string;
}

export function resolveDataRoot(input: DataRootInput): string {
  const override = input.env["ABB_DATA_ROOT"]?.trim();
  if (override) return resolve(override);
  if (input.isPackaged) return dirname(input.exePath);
  // desktop/ 的上一级就是仓库根
  return resolve(input.appPath, "..");
}
