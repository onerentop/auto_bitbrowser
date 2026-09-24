/**
 * 启动时按已保存的配置应用主题
 *
 * 读取失败（后端尚未就绪等）时保持默认 auto，不抛错。
 */
import { IPC, invoke } from "../../lib/ipc.ts";
import { normalizeThemeMode, setThemeMode } from "../../stores/theme.ts";

export async function initThemeFromConfig(): Promise<void> {
  try {
    // 只取 theme 的专用通道：settingsLoad 会把解密后的 API Key 等一并发到渲染层
    const { theme } = await invoke(IPC.invoke.settingsGetTheme);
    setThemeMode(normalizeThemeMode(theme));
  } catch {
    // 保持默认主题
  }
}
