/**
 * 全局任务坞：底部状态条（运行时顶边一条细进度条）+ 日志抽屉 + 结果汇总弹窗
 *
 * 各页面的日志区、进度与「停止」按钮统一收在这里。
 * 合成一个全局的即可，因为后端本来就只允许一个任务同时运行。
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { Button, Descriptions, Drawer, Modal, Space, Typography } from "antd";
import { StopOutlined, UnorderedListOutlined } from "@ant-design/icons";
import type { TaskFinishedEvent } from "../../../shared/ipc.ts";
import { describeError } from "../lib/ipc.ts";
import { clearLogs, onTaskFinished, stopTask, useTaskState } from "../stores/task.ts";
import { useTokens } from "../theme/tokens.ts";

const OUTCOME_TEXT: Record<TaskFinishedEvent["outcome"], string> = {
  succeeded: "已完成",
  failed: "失败",
  stopped: "已停止",
};

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toTimeString().slice(0, 8);
}

/** 常见结果字段的中文名；未列出的字段原样显示键名 */
const RESULT_LABELS: Record<string, string> = {
  total: "总数",
  total_count: "总数",
  success_count: "成功",
  failed_count: "失败",
  fail_count: "失败",
  failed_ids: "失败窗口",
  failed_list: "失败列表",
  warning_list: "警告",
  skipped_count: "跳过",
  results: "明细",
  deleted_accounts: "已删除账号",
  deleted_windows: "已删除窗口",
  password_count: "写入密码",
  bind_count: "绑定窗口",
  ix_update_count: "写入窗口 2FA 密钥",
  success_rate: "成功率",
  duration_seconds: "耗时（秒）",
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** 把任务结果对象平铺成「字段: 值」行，列表字段只显示条数 */
function summarize(result: unknown): Array<[string, string]> {
  if (!isPlainObject(result)) {
    return result === null || result === undefined ? [] : [["结果", JSON.stringify(result)]];
  }
  // 账号管理的批量任务返回 { type, result: {...} }，展开内层统计
  const flat = typeof result["type"] === "string" && isPlainObject(result["result"]) ? result["result"] : result;
  return Object.entries(flat).map(([k, v]) => {
    const label = RESULT_LABELS[k] ?? k;
    if (Array.isArray(v)) return [label, `${v.length} 项`];
    if (v !== null && typeof v === "object") return [label, JSON.stringify(v)];
    return [label, String(v)];
  });
}

export function TaskDock(): ReactElement {
  const { running, logs } = useTaskState();
  const t = useTokens();
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
  const rows = finished ? summarize(finished.result) : [];

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
                    Modal.error({ title: "停止失败", content: describeError(e) });
                  });
                }}
              >
                {stopping ? "正在停止" : "停止"}
              </Button>
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
        <pre className="abb-mono" style={{ margin: 0, fontSize: 12, lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          {logs.map((l) => `${formatTime(l.at)}  ${l.message}`).join("\n")}
        </pre>
        <div ref={bottomRef} />
      </Drawer>

      <Modal
        title={finished ? `${finished.label}：${OUTCOME_TEXT[finished.outcome]}` : ""}
        open={finished !== null}
        onCancel={() => setFinished(null)}
        footer={
          <Space>
            <Button onClick={() => setOpen(true)}>查看日志</Button>
            <Button type="primary" onClick={() => setFinished(null)}>
              知道了
            </Button>
          </Space>
        }
      >
        {finished?.error ? (
          <Typography.Paragraph type="danger" style={{ marginBottom: 12 }}>
            {finished.error}
          </Typography.Paragraph>
        ) : null}
        {finished && rows.length > 0 ? (
          <Descriptions size="small" column={1} bordered items={rows.map(([k, v], i) => ({ key: i, label: k, children: v }))} />
        ) : null}
      </Modal>
    </>
  );
}
