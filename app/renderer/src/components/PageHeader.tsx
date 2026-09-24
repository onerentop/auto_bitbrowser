/**
 * 页头：标题 + 一句说明 + 右侧主操作（每个页面顶部统一使用）
 */
import type { ReactElement, ReactNode } from "react";
import { Typography } from "antd";

export interface PageHeaderProps {
  title: string;
  /** 一句话说明这个页面做什么（用户视角） */
  description?: ReactNode;
  /** 右侧主操作 */
  extra?: ReactNode;
}

export function PageHeader({ title, description, extra }: PageHeaderProps): ReactElement {
  return (
    <header style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
      <div style={{ minWidth: 0 }}>
        <Typography.Title level={4} style={{ margin: 0, fontWeight: 600, lineHeight: 1.4 }}>
          {title}
        </Typography.Title>
        {description ? (
          <Typography.Text type="secondary" style={{ display: "block", marginTop: 2 }}>
            {description}
          </Typography.Text>
        ) : null}
      </div>
      {extra ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>{extra}</div> : null}
    </header>
  );
}
