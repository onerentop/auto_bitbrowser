/**
 * 设计令牌（「值班台」设计系统，见 .trellis/tasks/09-25-ui-redesign/design.md）
 *
 * 冷灰底 + 靛蓝主色；颜色只留给状态（ok / warn / bad）与主操作。
 * 页面代码不写死颜色：antd 组件走 buildTheme() 注入的主题，自绘元素用 useTokens() 取色。
 * 这是渲染层唯一允许出现颜色字面量的文件。
 */
import { theme as antdTheme, type ThemeConfig } from "antd";
import { useIsDark } from "../stores/theme.ts";

export interface Palette {
  /** 页面底 */
  canvas: string;
  /** 面板 / 表格 / 侧栏 */
  surface: string;
  /** 正文 */
  ink: string;
  /** 次要文字 */
  muted: string;
  /** 分隔线 / 边框 */
  line: string;
  /** 主色 */
  indigo: string;
  /** 主色的浅底（选中行、选中菜单） */
  indigoSoft: string;
  ok: string;
  warn: string;
  bad: string;
  /** 未知 / 未启用状态的圆点 */
  idle: string;
}

const LIGHT: Palette = {
  canvas: "#F5F6F8",
  surface: "#FFFFFF",
  ink: "#1E2329",
  muted: "#6A7280",
  line: "#E2E5EA",
  indigo: "#3D4FB5",
  indigoSoft: "#ECEEF9",
  ok: "#2F8F5B",
  warn: "#B7791F",
  bad: "#C8423B",
  idle: "#A3AAB5",
};

const DARK: Palette = {
  canvas: "#15171C",
  surface: "#1C1F26",
  ink: "#E6E8EC",
  muted: "#9AA1AD",
  line: "#2C313A",
  indigo: "#7D8BE0",
  indigoSoft: "#262B45",
  ok: "#4CB782",
  warn: "#D9A441",
  bad: "#E5675F",
  idle: "#5C6370",
};

export const FONT_FAMILY =
  '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
export const MONO_FAMILY = 'Consolas, "Cascadia Mono", monospace';

export function palette(dark: boolean): Palette {
  return dark ? DARK : LIGHT;
}

/** 当前主题的调色板（深浅色切换时自动更新） */
export function useTokens(): Palette {
  return palette(useIsDark());
}

/** 把调色板写成 <html> 上的 --abb-* 变量，供 app.css 里的自绘元素（任务坞进度条、焦点框、滚动条）使用 */
export function applyCssVars(dark: boolean): void {
  const p = palette(dark);
  const s = document.documentElement.style;
  for (const [k, v] of Object.entries(p)) s.setProperty(`--abb-${k}`, v);
  s.setProperty("--abb-mono", MONO_FAMILY);
  s.colorScheme = dark ? "dark" : "light";
}

/** antd 主题：全局令牌 + 少量组件覆盖；reduceMotion 对应系统的「减少动态效果」 */
export function buildTheme(dark: boolean, reduceMotion = false): ThemeConfig {
  const p = palette(dark);
  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: p.indigo,
      colorInfo: p.indigo,
      colorLink: p.indigo,
      colorSuccess: p.ok,
      colorWarning: p.warn,
      colorError: p.bad,
      colorBgLayout: p.canvas,
      colorBgContainer: p.surface,
      colorText: p.ink,
      colorTextSecondary: p.muted,
      colorBorder: p.line,
      colorBorderSecondary: p.line,
      colorSplit: p.line,
      fontFamily: FONT_FAMILY,
      fontFamilyCode: MONO_FAMILY,
      fontSize: 13,
      fontSizeHeading4: 16,
      fontSizeHeading5: 14,
      borderRadius: 6,
      borderRadiusLG: 8,
      borderRadiusSM: 4,
      controlHeight: 30,
      boxShadowTertiary: "none",
      motionDurationMid: "0.15s",
      // 系统开启「减少动态效果」时关闭 antd 的全部动效（官方开关，弹窗 / 抽屉照常开关）
      motion: !reduceMotion,
    },
    components: {
      Layout: { bodyBg: p.canvas, siderBg: p.surface, headerBg: p.surface },
      Menu: {
        itemBg: p.surface,
        subMenuItemBg: p.surface,
        itemSelectedBg: p.indigoSoft,
        itemSelectedColor: p.indigo,
        itemColor: p.ink,
        groupTitleColor: p.muted,
        groupTitleFontSize: 12,
        itemHeight: 34,
        itemMarginInline: 8,
        itemBorderRadius: 6,
        activeBarBorderWidth: 0,
      },
      // 列表规范（.trellis/tasks/09-25-list-display-design/design.md）：
      // 行高约 40px、无斑马纹、1px 分隔线；悬停 canvas、选中 indigoSoft；表头 muted（字号 / 字重在 app.css）
      Table: {
        headerBg: p.surface,
        headerColor: p.muted,
        headerSplitColor: "transparent",
        headerSortActiveBg: p.surface,
        headerSortHoverBg: p.canvas,
        rowHoverBg: p.canvas,
        rowSelectedBg: p.indigoSoft,
        rowSelectedHoverBg: p.indigoSoft,
        borderColor: p.line,
        cellPaddingBlockSM: 8,
        cellPaddingInlineSM: 12,
        bodySortBg: "transparent",
      },
      Card: { headerFontSize: 14, headerHeightSM: 40 },
      Tabs: { horizontalMargin: "0 0 12px 0" },
      Tag: { defaultBg: p.canvas, defaultColor: p.ink },
      Segmented: { itemSelectedBg: p.surface, trackBg: p.canvas },
    },
  };
}
