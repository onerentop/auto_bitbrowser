/**
 * 「运行状态」页（原骨架阶段的唯一视图）
 *
 * 展示四组信息，分别证明四段链路是通的：
 *   运行时版本     渲染层 → 预加载 → 主进程本地 handler
 *   后端进程状态   主进程 → 渲染层 的事件推送（实时）
 *   后端 ping      主进程 → utilityProcess 后端进程 的请求/响应
 *   ixBrowser      后端进程 → 已移植的 desktop/src 业务模块 → 本地 53200 服务
 */
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Alert, Badge, Button, Card, Descriptions, Space, Typography } from "antd";
import type { AppVersionInfo, HostPingResult, HostState, IxBrowserPingResult } from "../../../shared/ipc.ts";
import { IPC, describeError, invoke } from "../lib/ipc.ts";
import { useHostStatus } from "../stores/host-status.ts";

/** 后端状态 → 徽标颜色与中文 */
const HOST_STATE_VIEW: Record<HostState, { status: "success" | "processing" | "error" | "default"; text: string }> = {
  ready: { status: "success", text: "就绪" },
  starting: { status: "processing", text: "启动中" },
  crashed: { status: "error", text: "已崩溃" },
  stopped: { status: "default", text: "已停止" },
};

type Loadable<T> = { loading: boolean; data: T | null; error: string | null };
const idle = <T,>(): Loadable<T> => ({ loading: false, data: null, error: null });

export function StatusPage(): ReactElement {
  const hostStatus = useHostStatus();
  const [version, setVersion] = useState<Loadable<AppVersionInfo>>(idle);
  const [ping, setPing] = useState<Loadable<HostPingResult & { rttMs: number }>>(idle);
  const [ix, setIx] = useState<Loadable<IxBrowserPingResult>>(idle);
  const [restarting, setRestarting] = useState(false);

  const loadVersion = useCallback(async () => {
    setVersion((s) => ({ ...s, loading: true }));
    try {
      setVersion({ loading: false, data: await invoke(IPC.invoke.appGetVersion), error: null });
    } catch (e) {
      setVersion({ loading: false, data: null, error: describeError(e) });
    }
  }, []);

  const runPing = useCallback(async () => {
    setPing((s) => ({ ...s, loading: true }));
    const started = performance.now();
    try {
      const data = await invoke(IPC.invoke.hostPing);
      setPing({ loading: false, data: { ...data, rttMs: Math.round(performance.now() - started) }, error: null });
    } catch (e) {
      setPing({ loading: false, data: null, error: describeError(e) });
    }
  }, []);

  const runIxPing = useCallback(async () => {
    setIx((s) => ({ ...s, loading: true }));
    try {
      setIx({ loading: false, data: await invoke(IPC.invoke.ixbrowserPing), error: null });
    } catch (e) {
      setIx({ loading: false, data: null, error: describeError(e) });
    }
  }, []);

  const restartHost = useCallback(async () => {
    setRestarting(true);
    try {
      await invoke(IPC.invoke.hostRestart);
    } catch {
      // 重启失败会体现在后端状态（crashed + 原因）上，这里不再重复提示
    } finally {
      setRestarting(false);
    }
  }, []);

  useEffect(() => {
    void loadVersion();
  }, [loadVersion]);

  // 后端每次进入 ready（首次启动或重启后）自动探活一次
  const hostReady = hostStatus?.state === "ready";
  const hostPid = hostStatus?.pid ?? null;
  useEffect(() => {
    if (!hostReady) return;
    void runPing();
    void runIxPing();
  }, [hostReady, hostPid, runPing, runIxPing]);

  const stateView = hostStatus ? HOST_STATE_VIEW[hostStatus.state] : null;

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Card title="运行时版本" size="small" loading={version.loading && !version.data}>
            {version.error ? (
              <Alert type="error" showIcon message="读取版本失败" description={version.error} />
            ) : (
              <Descriptions size="small" column={3} bordered>
                <Descriptions.Item label="应用">
                  {version.data ? `${version.data.appName} ${version.data.appVersion}` : "—"}
                </Descriptions.Item>
                <Descriptions.Item label="Electron">{version.data?.electron ?? "—"}</Descriptions.Item>
                <Descriptions.Item label="Chrome">{version.data?.chrome ?? "—"}</Descriptions.Item>
                <Descriptions.Item label="Node（主进程）">{version.data?.node ?? "—"}</Descriptions.Item>
                <Descriptions.Item label="平台">
                  {version.data ? `${version.data.platform} / ${version.data.arch}` : "—"}
                </Descriptions.Item>
                <Descriptions.Item label="数据目录" span={3}>
                  <Typography.Text copyable>{version.data?.dataRoot ?? "—"}</Typography.Text>
                </Descriptions.Item>
              </Descriptions>
            )}
          </Card>

          <Card
            title="后端进程"
            size="small"
            extra={
              <Space>
                <Button size="small" onClick={() => void runPing()} loading={ping.loading} disabled={!hostReady}>
                  Ping
                </Button>
                <Button size="small" danger onClick={() => void restartHost()} loading={restarting}>
                  重启后端
                </Button>
              </Space>
            }
          >
            <Descriptions size="small" column={2} bordered>
              <Descriptions.Item label="状态">
                {stateView ? <Badge status={stateView.status} text={stateView.text} /> : "未知"}
                {hostStatus?.detail ? (
                  <Typography.Text type="danger" style={{ marginLeft: 8 }}>
                    {hostStatus.detail}
                  </Typography.Text>
                ) : null}
              </Descriptions.Item>
              <Descriptions.Item label="PID">{hostStatus?.pid ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="往返耗时">
                {ping.error ? (
                  <Typography.Text type="danger">{ping.error}</Typography.Text>
                ) : ping.data ? (
                  `${ping.data.rttMs} ms`
                ) : (
                  "—"
                )}
              </Descriptions.Item>
              <Descriptions.Item label="Node（后端进程）">{ping.data?.node ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="后端已运行">
                {ping.data ? `${ping.data.uptimeSec} s` : "—"}
              </Descriptions.Item>
            </Descriptions>
          </Card>

          <Card
            title="ixBrowser 本地服务"
            size="small"
            extra={
              <Button size="small" onClick={() => void runIxPing()} loading={ix.loading} disabled={!hostReady}>
                检测
              </Button>
            }
          >
            {ix.error ? (
              <Alert type="error" showIcon message="检测请求失败" description={ix.error} />
            ) : (
              <Descriptions size="small" column={2} bordered>
                <Descriptions.Item label="状态">
                  {ix.data ? (
                    <Badge status={ix.data.reachable ? "success" : "warning"} text={ix.data.reachable ? "已连接" : "未连接"} />
                  ) : (
                    "—"
                  )}
                </Descriptions.Item>
                <Descriptions.Item label="地址">{ix.data?.endpoint ?? "—"}</Descriptions.Item>
                <Descriptions.Item label="耗时">{ix.data ? `${ix.data.elapsedMs} ms` : "—"}</Descriptions.Item>
                <Descriptions.Item label="原因">
                  {ix.data?.error ? <Typography.Text type="warning">{ix.data.error}</Typography.Text> : "—"}
                </Descriptions.Item>
              </Descriptions>
            )}
          </Card>
    </Space>
  );
}
