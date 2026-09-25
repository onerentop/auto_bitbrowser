/**
 * 侧栏底部的状态灯：后端进程 + ixBrowser 本地服务（圆点 + 文字），点击进入运行状态页；
 * 侧栏收起时只显示圆点
 */
import type { ReactElement } from "react";
import { Tooltip, Typography } from "antd";
import { useHostStatus } from "../stores/host-status.ts";
import { useIxStatus } from "../stores/ix-status.ts";
import { useTokens, type Palette } from "../theme/tokens.ts";

type Tone = "ok" | "warn" | "bad" | "idle";

interface Light {
  label: string;
  tone: Tone;
  text: string;
  tip: string;
}

function toneColor(t: Palette, tone: Tone): string {
  return tone === "ok" ? t.ok : tone === "warn" ? t.warn : tone === "bad" ? t.bad : t.idle;
}

/** compact：侧栏收起时只显示两个圆点（名称与状态放进悬停提示） */
export function StatusLights({ onOpen, compact = false }: { onOpen: () => void; compact?: boolean }): ReactElement {
  const t = useTokens();
  const host = useHostStatus();
  const ix = useIxStatus();

  const hostLight: Light =
    host?.state === "ready"
      ? { label: "后端", tone: "ok", text: "就绪", tip: `后端进程运行中（PID ${host.pid ?? "—"}）` }
      : host?.state === "starting"
        ? { label: "后端", tone: "warn", text: "启动中", tip: "后端进程正在启动" }
        : host?.state === "crashed"
          ? { label: "后端", tone: "bad", text: "已崩溃", tip: host.detail ?? "后端进程已崩溃，可在运行状态页重启" }
          : { label: "后端", tone: "idle", text: host ? "已停止" : "未知", tip: "后端进程未运行" };

  const ixLight: Light =
    host?.state !== "ready"
      ? { label: "ixBrowser", tone: "idle", text: "未检测", tip: "后端就绪后自动检测" }
      : ix.data?.reachable
        ? { label: "ixBrowser", tone: "ok", text: "已连接", tip: `${ix.data.endpoint}，${ix.data.elapsedMs} ms` }
        : ix.data || ix.error
          ? {
              label: "ixBrowser",
              tone: "bad",
              text: "未连接",
              tip: `${ix.data?.error ?? ix.error ?? ""}\n请确认 ixBrowser 已启动`,
            }
          : { label: "ixBrowser", tone: "idle", text: "检测中", tip: "正在检测 ixBrowser 本地服务" };

  // 读屏 / 键盘用户拿不到悬停提示，把状态与原因一起放进按钮的可访问名称
  const spoken = [hostLight, ixLight].map((l) => `${l.label}${l.text}：${l.tip.replace(/\n/g, "，")}`).join("；");

  const dot = (l: Light): ReactElement => (
    <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: toneColor(t, l.tone), flex: "none" }} />
  );

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${spoken}。打开运行状态页查看详情`}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: compact ? "center" : "stretch",
        gap: compact ? 10 : 6,
        width: "100%",
        padding: compact ? "14px 0" : "12px 20px",
        border: "none",
        borderTop: `1px solid ${t.line}`,
        background: "transparent",
        cursor: "pointer",
        textAlign: "left",
        font: "inherit",
      }}
    >
      {[hostLight, ixLight].map((l) => (
        <Tooltip
          key={l.label}
          // 收起时圆点旁没有文字，提示里补上「名称 状态」
          title={<span style={{ whiteSpace: "pre-line" }}>{compact ? `${l.label} ${l.text}\n${l.tip}` : l.tip}</span>}
          placement="right"
        >
          {compact ? (
            <span style={{ display: "flex", padding: 2 }}>{dot(l)}</span>
          ) : (
            <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
              {dot(l)}
              <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1 }}>
                {l.label}
              </Typography.Text>
              <Typography.Text style={{ fontSize: 12, color: l.tone === "idle" ? t.muted : toneColor(t, l.tone) }}>
                {l.text}
              </Typography.Text>
            </span>
          )}
        </Tooltip>
      ))}
    </button>
  );
}
