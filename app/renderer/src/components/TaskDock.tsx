/**
 * 全局任务坞：底部状态条（运行时顶边一条细进度条）+ 日志抽屉
 *
 * 各页面的日志区、进度与「停止」按钮统一收在这里。
 * 合成一个全局的即可，因为后端本来就只允许一个任务同时运行。
 *
 * 任务结束**不弹任何模态弹窗**：结果作为坞里的一行呈现，明细与完整日志在日志抽屉里。
 * 为什么这样分工、以及每个提示面各自的职责，见
 * `.trellis/tasks/09-26-ui-notifications/design.md`；结果文案见 `lib/task-result.ts`。
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { App, Button, Descriptions, Drawer, Typography } from "antd";
import { StopOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { describeError } from "../lib/ipc.ts";
import { taskResultView } from "../lib/task-result.ts";
import { clearLogs, stopTask, useTaskState } from "../stores/task.ts";
import { useTokens } from "../theme/tokens.ts";

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toTimeString().slice(0, 8);
}

export function TaskDock(): ReactElement {
  const { running, logs, lastFinished } = useTaskState();
  const { notification } = App.useApp();
  const t = useTokens();
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!running) setStopping(false);
  }, [running]);
  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [logs, open]);

  const percent = running && running.total > 0 ? Math.round((running.current / running.total) * 100) : 0;
  const last = logs.at(-1);
  /** 最近一次结束的任务；结果行与抽屉里的明细都用它 */
  const result = lastFinished ? taskResultView(lastFinished) : null;
  const toneColor = result
    ? { ok: t.ok, warn: t.warn, bad: t.bad, none: t.muted }[result.tone]
    : t.muted;

  return (
    <>
      <div style={{ background: t.surface, borderTop: `1px solid ${t.line}` }}>
        {/* 全应用唯一的动效：任务运行时的细进度条（不知道总数时往复移动，减少动态效果时静止） */}
        {running ? (
          <div
            className="abb-dock-bar"
            data-indeterminate={running.total > 0 ? "false" : "true"}
            role="progressbar"
            aria-label={running.label}
            aria-valuemin={0}
            aria-valuemax={running.total > 0 ? running.total : undefined}
            aria-valuenow={running.total > 0 ? running.current : undefined}
          >
            <span style={running.total > 0 ? { width: `${percent}%` } : undefined} />
          </div>
        ) : null}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 16px 0 24px", minHeight: 38 }}>
          {running ? (
            <>
              <Typography.Text strong>{running.label}</Typography.Text>
              <Typography.Text type="secondary" className="abb-num">
                {running.total > 0 ? `${running.current} / ${running.total}` : "进行中"}
              </Typography.Text>
              <Button
                size="small"
                danger
                icon={<StopOutlined />}
                loading={stopping}
                onClick={() => {
                  setStopping(true);
                  stopTask().catch((e: unknown) => {
                    setStopping(false);
                    notification.error({ message: "停止失败", description: describeError(e) });
                  });
                }}
              >
                {stopping ? "正在停止" : "停止"}
              </Button>
            </>
          ) : result && lastFinished ? (
            // 任务结束后唯一的提示面：任务名 + 一句人话摘要（配色按结果色调取令牌）
            <>
              <Typography.Text strong>{lastFinished.label}</Typography.Text>
              <Typography.Text
                title={result.summary}
                style={{
                  color: toneColor,
                  fontSize: 13,
                  maxWidth: "45%",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {result.summary}
              </Typography.Text>
            </>
          ) : (
            <Typography.Text type="secondary">没有正在运行的任务</Typography.Text>
          )}
          <Typography.Text type="secondary" ellipsis style={{ flex: 1, minWidth: 0, fontSize: 12 }}>
            {last ? `${formatTime(last.at)}  ${last.message}` : ""}
          </Typography.Text>
          <Button size="small" type="text" icon={<UnorderedListOutlined />} onClick={() => setOpen(true)}>
            日志 {logs.length}
          </Button>
        </div>
      </div>

      <Drawer
        title="任务日志"
        placement="bottom"
        height="45vh"
        open={open}
        onClose={() => setOpen(false)}
        extra={
          <Button size="small" onClick={clearLogs}>
            清空
          </Button>
        }
      >
        {result && lastFinished && result.details.length > 0 ? (
          <div style={{ marginBottom: 16 }}>
            <Typography.Text strong style={{ fontSize: 12 }}>
              {lastFinished.label} 的结果明细
            </Typography.Text>
            <Descriptions
              size="small"
              column={1}
              bordered
              style={{ marginTop: 8 }}
              items={result.details.map(([k, v], i) => ({ key: i, label: k, children: v }))}
            />
          </div>
        ) : null}
        <pre className="abb-mono" style={{ margin: 0, fontSize: 12, lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          {logs.map((l) => `${formatTime(l.at)}  ${l.message}`).join("\n")}
        </pre>
        <div ref={bottomRef} />
      </Drawer>
    </>
  );
}
