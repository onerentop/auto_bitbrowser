/**
 * 通用 AI 批量任务页（开发中占位）
 */
import type { ReactElement } from "react";
import { Typography } from "antd";

export interface AiTaskPageProps {
  /** 任务种类键，见 app/shared/channels/ai-tasks.ts 的 AI_TASK_KINDS */
  kind: string;
  label: string;
}

export function AiTaskPage(props: AiTaskPageProps): ReactElement {
  return <Typography.Text type="secondary">{props.label}（开发中）</Typography.Text>;
}
