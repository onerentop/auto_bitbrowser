/**
 * 导航与来源校验 —— 纯函数，不依赖 electron，可被 node --test 直接导入
 *
 * 代码审查发现的漏洞：早期版本用 `url.startsWith("file:")` 放行导航，
 * 生产模式下本机任意 file:// 页面（例如把一个 .html 拖进窗口）都能加载，
 * 而预加载脚本会注入到这个 webContents 加载的每个页面 —— 该页面随即拿到
 * window.abb，可以调用白名单里的所有通道。
 *
 * 现在只放行应用自己的渲染层入口：
 *   - 开发模式：electron-vite 的 dev server 同源地址
 *   - 生产模式：精确等于 out/renderer/index.html 的 file:// URL（忽略 hash 与 query）
 * 主进程的 IPC 处理也用同一个函数校验 event.senderFrame.url。
 */

export interface AppOrigin {
  /** 开发模式下渲染层的 dev server 地址；生产模式为 undefined */
  devServerUrl?: string | undefined;
  /** 生产模式下渲染层入口的 file:// URL（由 pathToFileURL 得到） */
  entryFileUrl: string;
}

/**
 * 去掉 hash 与 query，得到可比较的地址。
 * 只把 Windows 盘符统一成小写（file:///C:/… 与 file:///c:/… 是同一个文件），
 * 路径其余部分保持原样：Linux/macOS 的文件系统区分大小写，整体小写化会误放行。
 */
function comparable(url: URL): string {
  const pathname = url.pathname.replace(/^\/([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}:`);
  return `${url.protocol}//${url.host}${pathname}`;
}

/** 判断一个 URL 是否属于本应用的渲染层 */
export function isAppUrl(rawUrl: string | undefined | null, origin: AppOrigin): boolean {
  if (!rawUrl) return false;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (origin.devServerUrl) {
    let dev: URL;
    try {
      dev = new URL(origin.devServerUrl);
    } catch {
      return false;
    }
    // dev server 同源即可（Vite 会请求 /@vite/client 等同源资源，HMR 也可能改变路径）
    return url.origin === dev.origin;
  }

  if (url.protocol !== "file:") return false;

  let entry: URL;
  try {
    entry = new URL(origin.entryFileUrl);
  } catch {
    return false;
  }
  return comparable(url) === comparable(entry);
}
