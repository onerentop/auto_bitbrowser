/**
 * electron-vite 构建配置
 *
 * 三段产物（与 PI-Desktop 的 out/ 布局一致）：
 *   out/main/index.js      主进程（薄壳）
 *   out/main/host.js       后端进程入口（utilityProcess，对标 PI 的 plugin-host-process.js）
 *   out/preload/index.cjs  预加载脚本（开了 sandbox 必须是 CJS）
 *   out/renderer/          渲染层（React + Ant Design）
 *
 * main / preload 默认开启 build.externalizeDeps：package.json 里 dependencies
 * 列出的运行时依赖（stagehand、playwright-core、ai-sdk 等）与 node:* 内置模块
 * 都不打进包里，运行时从 node_modules 加载。
 */
import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";

const r = (p: string): string => resolve(__dirname, p);

/**
 * 仅开发模式：给 CSP 的 script-src 加上 'unsafe-inline'。
 * React Fast Refresh 需要一段内联前导脚本；生产构建（apply: "build"）不经过本插件，
 * 所以打出来的 index.html 保持严格的 script-src 'self'。
 */
function devRelaxCsp(): Plugin {
  return {
    name: "abb-dev-relax-csp",
    apply: "serve",
    transformIndexHtml(html: string) {
      return html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';");
    },
  };
}

export default defineConfig({
  main: {
    build: {
      outDir: r("out/main"),
      rollupOptions: {
        input: {
          index: r("app/main/index.ts"),
          host: r("app/host/index.ts"),
        },
      },
    },
  },

  preload: {
    build: {
      outDir: r("out/preload"),
      rollupOptions: {
        input: { index: r("app/preload/index.ts") },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },

  renderer: {
    root: r("app/renderer"),
    plugins: [react(), devRelaxCsp()],
    build: {
      outDir: r("out/renderer"),
      rollupOptions: {
        input: { index: r("app/renderer/index.html") },
      },
    },
  },
});
