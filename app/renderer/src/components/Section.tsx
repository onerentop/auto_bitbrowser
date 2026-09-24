/**
 * 页面主体的容器（替代「卡片套卡片」）
 *
 * Panel：一块 surface 面板（1px 分隔线、圆角 8、无阴影）；fill 时占满剩余高度（列表页的表格用）。
 * Section：面板内的一个分节，可选标题（14/600）与右侧操作；相邻分节之间一条分隔线。
 */
import type { CSSProperties, ReactElement, ReactNode } from "react";
import { Typography } from "antd";
import { useTokens } from "../theme/tokens.ts";

export interface PanelProps {
  children: ReactNode;
  /** 占满父容器剩余高度，内部纵向 flex（表格区域可再用 flex:1 撑满） */
  fill?: boolean;
  /** 内边距，默认 16 */
  padding?: number | string;
  style?: CSSProperties;
}

export function Panel({ children, fill, padding = 16, style }: PanelProps): ReactElement {
  const t = useTokens();
  return (
    <section
      style={{
        background: t.surface,
        border: `1px solid ${t.line}`,
        borderRadius: 8,
        padding,
        ...(fill ? { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 12 } : {}),
        ...style,
      }}
    >
      {children}
    </section>
  );
}

export interface SectionProps {
  title?: ReactNode;
  /** 标题右侧的操作 */
  extra?: ReactNode;
  /** 标题下的一句说明 */
  description?: ReactNode;
  children: ReactNode;
  /** 第一个分节不画上分隔线 */
  first?: boolean;
}

export function Section({ title, extra, description, children, first }: SectionProps): ReactElement {
  const t = useTokens();
  return (
    <div style={first ? undefined : { borderTop: `1px solid ${t.line}`, marginTop: 16, paddingTop: 16 }}>
      {title || extra ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
          <div>
            {title ? (
              <Typography.Text strong style={{ fontSize: 14 }}>
                {title}
              </Typography.Text>
            ) : null}
            {description ? (
              <Typography.Text type="secondary" style={{ display: "block", fontSize: 12, marginTop: 2 }}>
                {description}
              </Typography.Text>
            ) : null}
          </div>
          {extra}
        </div>
      ) : null}
      {children}
    </div>
  );
}
