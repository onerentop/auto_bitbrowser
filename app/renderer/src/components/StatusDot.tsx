/**
 * 列表状态单元格：7px 圆点 + 状态文字（颜色跟色调），可选一段原因（muted、单行省略、悬停看全文）
 *
 * 列表里的状态一律用它，不用带底色的 Tag：整行的强调交给行首 3px 状态条（railClass）。
 */
import type { ReactElement } from "react";
import { Tooltip } from "antd";
import type { ListTone } from "../lib/list-tone.ts";

export function StatusDot({ tone, text, reason }: { tone: ListTone; text: string; reason?: string | null }): ReactElement {
  const dot = (
    <span className={`abb-dot abb-tone-${tone}`}>
      {text}
      {reason ? <span className="abb-dot-reason">{reason}</span> : null}
    </span>
  );
  return reason ? (
    <Tooltip title={reason} placement="topLeft">
      {dot}
    </Tooltip>
  ) : (
    dot
  );
}
