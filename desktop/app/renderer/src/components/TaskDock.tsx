/**
 * 全局任务坞：底部状态条 + 日志抽屉 + 结果汇总弹窗
 *
 * 对标 Python 各页面的日志区（BaseInterface.addLogArea）、进度条与「停止」按钮。
 * Python 每个页面各有一块日志区；这里合成一个全局的，因为后端本来就只允许一个任务同时运行。
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { Button, Drawer, Modal, Progress, Space, Typography } from "antd";
import { StopOutlined, UnorderedListOutlined } from "@ant-design/icons";
import type { TaskFinishedEvent } from "../../../shared/ipc.ts";
import { describeError } from "../lib/ipc.ts";
import { clearLogs, onTaskFinished, stopTask, useTaskState } from "../stores/task.ts";

const OUTCOME_TEXT: Record<TaskFinishedEvent["outcome"], string> = {
  succeeded: "已完成",
  failed: "失败",
  stopped: "已停止",
};

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toTimeString().slice(0, 8);
}

/** 把任务结果对象平铺成「键: 值」行，列表字段只显示条数 */
function summarize(result: unknown): Array<[string, string]> {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return result === null || result === undefined ? [] : [["结果", JSON.stringify(result)]];
  }
  return Object.entries(result as Record<string, unknown>).map(([k, v]) => {
    if (Array.isArray(v)) return [k, `${v.length} 项`];
    if (v !== null && typeof v === "object") return [k, JSON.stringify(v)];
    return [k, String(v)];
  });
}

export function TaskDock(): ReactElement {
  const { running, logs } = useTaskState();
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [finished, setFinished] = useState<TaskFinishedEvent | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => onTaskFinished((e) => setFinished(e)), []);
  useEffect(() => {
    if (!running) setStopping(false);
  }, [running]);
  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [logs, open]);

  const percent = running && running.total > 0 ? Math.round((running.current / running.total) * 100) : 0;
  const last = logs.at(-1);

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "6px 16px",
          borderTop: "1px solid rgba(128,128,128,0.2)",
          minHeight: 40,
        }}
      >
        {running ? (
          <>
            <Typography.Text strong>{running.label}</Typography.Text>
            <Progress
              percent={percent}
              size="small"
              style={{ width: 200, margin: 0 }}
              format={() => (running.total > 0 ? `${running.current}/${running.total}` : "…")}
            />
            <Button
              size="small"
              danger
              icon={<StopOutlined />}
              loading={stopping}
              onClick={() => {
                setStopping(true);
                stopTask().catch((e: unknown) => {
                  setStopping(false);
                  Modal.error({ title: "停止失败", content: describeError(e) });
                });
              }}
            >
              停止
            </Button>
          </>
        ) : (
          <Typography.Text type="secondary">空闲</Typography.Text>
        )}
        <Typography.Text type="secondary" ellipsis style={{ flex: 1, minWidth: 0 }}>
          {last ? `${formatTime(last.at)}  ${last.message}` : ""}
        </Typography.Text>
        <Button size="small" icon={<UnorderedListOutlined />} onClick={() => setOpen(true)}>
          日志（{logs.length}）
        </Button>
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
        <pre style={{ margin: 0, fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          {logs.map((l) => `${formatTime(l.at)}  ${l.message}`).join("\n")}
        </pre>
        <div ref={bottomRef} />
      </Drawer>

      <Modal
        title={finished ? `${finished.label} · ${OUTCOME_TEXT[finished.outcome]}` : ""}
        open={finished !== null}
        onCancel={() => setFinished(null)}
        footer={
          <Space>
            <Button onClick={() => setOpen(true)}>查看日志</Button>
            <Button type="primary" onClick={() => setFinished(null)}>
              确定
            </Button>
          </Space>
        }
      >
        {finished?.error ? <Typography.Text type="danger">{finished.error}</Typography.Text> : null}
        {finished
          ? summarize(finished.result).map(([k, v]) => (
              <div key={k}>
                <Typography.Text type="secondary">{k}：</Typography.Text>
                <Typography.Text>{v}</Typography.Text>
              </div>
            ))
          : null}
      </Modal>
    </>
  );
}
