/**
 * 列表点行即选中：给 antd `Table.onRow` 用的共享规则（六张表一份，别在页面里各写一遍）
 *
 * 规则：
 * - 点行内任意空白处（含单元格文字）切换该行选中；多选表再点一次取消。
 * - 单选表（`mode: "always"`）只选不取消 —— 点已选行仍是选中。
 * - `disabled` 为真的行（未绑定窗口 / 不可选 / 未匹配）点了不选中，光标也不摆成手型，
 *   与勾选框的 `disabled` 一致。
 * - 点行内的按钮 / 链接 / 输入框 / 下拉 / 勾选框 / 可编辑区，以及标了
 *   `data-no-row-select` 的单元格（账号页的验证码、标签、备注），只做它们自己的事。
 */
import type { CSSProperties } from "react";

/** 命中其一就不切换行选中：原生交互元素 + 我们自己标的「这格别抢行点击」 */
export const NO_SELECT_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "label",
  "[role='button']",
  "[contenteditable='true']",
  "[data-no-row-select]",
].join(",");

/**
 * 只用到节点的这几个字段，不写 `Element` 类型：
 * 单测在 Node 里跑（没有 DOM），假事件对象照样能过。
 */
interface TargetNode {
  nodeType?: number;
  parentElement?: TargetNode | null;
  closest?: (selector: string) => unknown;
}

/** 点单元格文字时事件 target 是文本节点，要拿它的宿主元素判断 */
function hostElement(target: unknown): TargetNode | null {
  if (typeof target !== "object" || target === null) return null;
  const node = target as TargetNode;
  if (node.nodeType === 1) return node;
  if (node.nodeType === 3) return node.parentElement ?? null;
  return null;
}

export interface RowClickEvent {
  target: unknown;
}

export interface RowSelectOptions<T, K extends string | number> {
  /** 从行数据取选中用的键 */
  keyOf: (record: T) => K;
  /** 当前的选中键 */
  keys: readonly K[];
  onChange: (next: K[]) => void;
  /** 该行不可选中（与勾选框 disabled 用同一个判断） */
  disabled?: (record: T) => boolean;
  /** `toggle`（默认，多选表可取消）/ `always`（单选表，点行只选中） */
  mode?: "toggle" | "always";
}

export interface RowSelectHandlers {
  onClick: (event: RowClickEvent) => void;
  style: CSSProperties;
}

export function rowSelect<T, K extends string | number>(
  options: RowSelectOptions<T, K>,
): (record: T) => RowSelectHandlers {
  const { keyOf, keys, onChange, disabled, mode = "toggle" } = options;
  return (record) => {
    // 不可选的行也别摆出可点的样子（手型光标）；与 onClick 里的判断是同一份
    const off = disabled?.(record) === true;
    return {
      onClick: (event) => {
        if (off) return;
        const host = hostElement(event?.target);
        if (!host || host.closest?.(NO_SELECT_SELECTOR)) return;
        const key = keyOf(record);
        if (mode === "always") {
          onChange([key]);
          return;
        }
        onChange(keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]);
      },
      style: { cursor: off ? "default" : "pointer" },
    };
  };
}
