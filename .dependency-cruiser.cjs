/**
 * 分层依赖规则（dependency-cruiser）
 *
 * 每条规则与 ARCHITECTURE.md §3.3 规则表一一对应（规则名相同）；改规则时两边一起改。
 * 运行：pnpm run check:deps（有 error 时非零退出）。
 *
 * 路径均相对仓库根。dependency-cruiser 会拒绝含嵌套量词的正则（ReDoS 防护），这里的正则都保持简单。
 */

/** 入口模块：没有别人引用它们是正常的，不算孤儿 */
const ENTRY_POINTS = [
  "^app/main/index\\.ts$",
  "^app/host/index\\.ts$",
  "^app/preload/index\\.ts$",
  "^app/renderer/src/main\\.tsx$",
  "^src/ixbrowser/probe\\.ts$",
  "^src/db/probe\\.ts$",
  "\\.d\\.ts$",
];

/** electron 包的解析路径（pnpm 下是 node_modules/.pnpm/electron@x/node_modules/electron/…，子串即可匹配） */
const ELECTRON = "node_modules/electron/";

module.exports = {
  forbidden: [
    // ---------- 通用 ----------
    {
      name: "no-circular",
      severity: "error",
      comment: "不得有运行时循环依赖；只由 import type 形成的环不算",
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } },
    },
    { name: "not-to-unresolvable", severity: "error", comment: "不得有解析不到的导入", from: {}, to: { couldNotResolve: true } },
    {
      name: "no-orphans",
      severity: "error",
      comment: "除入口外，每个模块都必须被引用（没人引用 = 死代码）",
      from: { orphan: true, pathNot: ENTRY_POINTS },
      to: {},
    },

    // ---------- 进程边界（app/） ----------
    {
      name: "shared-is-self-contained",
      severity: "error",
      comment: "app/shared 是共享内核：只依赖自身与外部 npm 包，不依赖 src/ 或其它 app 目录",
      from: { path: "^app/shared/" },
      to: { pathNot: "^app/shared/", dependencyTypesNot: ["npm", "npm-dev"] },
    },
    {
      name: "shared-no-node",
      severity: "error",
      comment: "app/shared 要在 Node 与浏览器两边都能跑，不用 Node 内置模块",
      from: { path: "^app/shared/" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "shared-no-electron",
      severity: "error",
      comment: "app/shared 不依赖 electron（shared-is-self-contained 放行 npm 包，electron 需单独拦）",
      from: { path: "^app/shared/" },
      to: { path: ELECTRON },
    },
    {
      name: "renderer-only-shared",
      severity: "error",
      comment: "渲染层只依赖 app/shared 与前端包，不直连 src/、host、main、preload（import type 也不行）",
      from: { path: "^app/renderer/" },
      to: { path: "^(src|app/(host|main|preload))/" },
    },
    {
      name: "renderer-no-node",
      severity: "error",
      comment: "渲染层不用 Node 内置模块",
      from: { path: "^app/renderer/" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "renderer-no-electron",
      severity: "error",
      comment: "渲染层不依赖 electron",
      from: { path: "^app/renderer/" },
      to: { path: ELECTRON },
    },
    {
      name: "main-is-thin",
      severity: "error",
      comment: "主进程只转发，不依赖 src/、host、renderer、preload",
      from: { path: "^app/main/" },
      to: { path: "^(src|app/(host|renderer|preload))/" },
    },
    {
      name: "preload-only-shared",
      severity: "error",
      comment: "预加载只依赖 app/shared",
      from: { path: "^app/preload/" },
      to: { path: "^(src|app/(host|renderer|main))/" },
    },
    {
      name: "host-no-electron-or-ui",
      severity: "error",
      comment: "后端跑在 utilityProcess，不依赖 electron 与 main / renderer / preload",
      from: { path: "^app/host/" },
      to: { path: `^app/(main|renderer|preload)/|${ELECTRON}` },
    },
    {
      name: "handlers-via-application",
      severity: "warn",
      comment: "handler 经 src/application 调业务，不直连 automation / engine（组合根 context.ts / index.ts 不在 handlers/ 下）；C3 完成后升为 error",
      from: { path: "^app/host/handlers/" },
      to: { path: "^src/(automation|engine)/" },
    },

    // ---------- 业务库（src/） ----------
    { name: "src-no-electron", severity: "error", comment: "src/ 不依赖 electron", from: { path: "^src/" }, to: { path: ELECTRON } },
    {
      name: "src-only-application-sees-contracts",
      severity: "error",
      comment: "src/ 里只有 application 可以依赖 app/",
      from: { path: "^src/", pathNot: "^src/application/" },
      to: { path: "^app/" },
    },
    {
      name: "application-only-contracts",
      severity: "error",
      comment: "src/application 只能依赖 app/shared/channels（IPC 契约）与 app/shared/logic（两端共用的纯函数）",
      from: { path: "^src/application/" },
      to: { path: "^app/", pathNot: "^app/shared/(channels|logic)/" },
    },
    {
      name: "automation-not-up",
      severity: "error",
      comment: "automation 不依赖 application、services",
      from: { path: "^src/automation/" },
      to: { path: "^src/(application|services)/" },
    },
    {
      name: "engine-not-up",
      severity: "error",
      comment: "engine 只操作页面：不依赖 application、automation、db、services",
      from: { path: "^src/engine/" },
      to: { path: "^src/(application|automation|db|services)/" },
    },
    {
      name: "services-not-up",
      severity: "error",
      comment: "services 不依赖 application、automation、engine",
      from: { path: "^src/services/" },
      to: { path: "^src/(application|automation|engine)/" },
    },
    {
      name: "infra-not-up",
      severity: "error",
      comment: "db / ixbrowser 是基础设施，不依赖 application、automation、engine、services",
      from: { path: "^src/(db|ixbrowser)/" },
      to: { path: "^src/(application|automation|engine|services)/" },
    },
    {
      name: "core-is-leaf",
      severity: "error",
      comment: "core 是最底层工具，不依赖 src/ 其它目录",
      from: { path: "^src/core/" },
      to: { path: "^src/(?!core/)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // 仅类型导入也参与分层检查：渲染层不能靠 import type 引用 src/
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { extensions: [".ts", ".tsx", ".mjs", ".js"] },
  },
};
