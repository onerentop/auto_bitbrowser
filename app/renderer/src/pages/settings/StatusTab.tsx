/**
 * 设置页「运行状态」标签（原独立的运行状态页并入设置）
 *
 * 三个分节，分别证明三段链路是通的：
 *   后端进程       主进程 → 渲染层 的事件推送（实时）+ 主进程 → utilityProcess 后端 的 ping
 *   ixBrowser     后端进程 → src 业务模块 → 本地 53200 服务（结果来自 stores/ix-status，与侧栏状态灯同一份）
 *   运行时版本     渲染层 → 预加载 → 主进程本地 handler
 */
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Alert, Button, Descriptions, Space, Typography } from "antd";
import type { AppVersionInfo, HostPingResult, HostState } from "../../../../shared/ipc.ts";
import type { ListTone } from "../../lib/list-tone.ts";
import { IPC, describeError, invoke } from "../../lib/ipc.ts";
import { useHostStatus } from "../../stores/host-status.ts";
import { refreshIxStatus, useIxStatus } from "../../stores/ix-status.ts";
import { Panel, Section } from "../../components/Section.tsx";
import { StatusDot } from "../../components/StatusDot.tsx";

/** 后端状态 → 色调与中文（与侧栏状态灯同一口径） */
const HOST_STATE_VIEW: Record<HostState, { tone: ListTone; text: string }> = {
  ready: { tone: "ok", text: "就绪" },
  starting: { tone: "warn", text: "启动中" },
  crashed: { tone: "bad", text: "已崩溃" },
  stopped: { tone: "none", text: "已停止" },
};

type Loadable<T> = { loading: boolean; data: T | null; error: string | null };
const idle = <T,>(): Loadable<T> => ({ loading: false, data: null, error: null });

/** 键值列表的统一外观：不加边框（面板已有边框），标签列定宽便于上下对齐 */
const DESC_PROPS = { size: "small", colon: false, styles: { label: { width: 128 } } } as const;

export function StatusTab(): ReactElement {
  const hostStatus = useHostStatus();
  const ix = useIxStatus();
  const [version, setVersion] = useState<Loadable<AppVersionInfo>>(idle);
  const [ping, setPing] = useState<Loadable<HostPingResult & { rttMs: number }>>(idle);
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

  // 后端每次进入 ready（首次启动或重启后）自动 ping 一次；ixBrowser 由外壳的状态灯轮询负责，这里不重复调用
  const hostReady = hostStatus?.state === "ready";
  const hostPid = hostStatus?.pid ?? null;
  useEffect(() => {
    if (!hostReady) return;
    void runPing();
  }, [hostReady, hostPid, runPing]);

  const stateView = hostStatus ? HOST_STATE_VIEW[hostStatus.state] : null;

  // 与侧栏状态灯（components/StatusLights.tsx）同一判定
  const ixView: { tone: ListTone; text: string } = !hostReady
    ? { tone: "none", text: "未检测" }
    : ix.data?.reachable
      ? { tone: "ok", text: "已连接" }
      : ix.data || ix.error
        ? { tone: "bad", text: "未连接" }
        : { tone: "none", text: "检测中" };

  return (
    <Panel>
      <Section
        first
        title="后端进程"
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
        <Descriptions {...DESC_PROPS} column={{ xs: 1, md: 2 }}>
          <Descriptions.Item label="状态">
            <Space size={8} wrap>
              {stateView ? <StatusDot tone={stateView.tone} text={stateView.text} /> : <StatusDot tone="none" text="未知" />}
              {hostStatus?.detail ? <Typography.Text type="danger">{hostStatus.detail}</Typography.Text> : null}
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="PID">
            <span className="abb-num">{hostStatus?.pid ?? "—"}</span>
          </Descriptions.Item>
          <Descriptions.Item label="往返耗时">
            {ping.error ? (
              <Typography.Text type="danger">{ping.error}</Typography.Text>
            ) : (
              <span className="abb-num">{ping.data ? `${ping.data.rttMs} ms` : "—"}</span>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="Node（后端进程）">{ping.data?.node ?? "—"}</Descriptions.Item>
          <Descriptions.Item label="后端已运行">
            <span className="abb-num">{ping.data ? `${ping.data.uptimeSec} s` : "—"}</span>
          </Descriptions.Item>
        </Descriptions>
      </Section>

      <Section
        title="ixBrowser 本地服务"
        description="后端就绪后每 30 秒自动检测一次，结果与侧栏状态灯一致"
        extra={
          <Button size="small" onClick={() => void refreshIxStatus()} loading={ix.loading} disabled={!hostReady}>
            检测
          </Button>
        }
      >
        {ix.error ? (
          <Alert type="error" showIcon message="检测请求失败" description={ix.error} style={{ marginBottom: 12 }} />
        ) : null}
        <Descriptions {...DESC_PROPS} column={{ xs: 1, md: 2 }}>
          <Descriptions.Item label="状态">
            <StatusDot tone={ixView.tone} text={ixView.text} />
          </Descriptions.Item>
          <Descriptions.Item label="地址">
            <span className="abb-num">{ix.data?.endpoint ?? "—"}</span>
          </Descriptions.Item>
          <Descriptions.Item label="耗时">
            <span className="abb-num">{ix.data ? `${ix.data.elapsedMs} ms` : "—"}</span>
          </Descriptions.Item>
          <Descriptions.Item label="上次检测">
            <span className="abb-num">{ix.checkedAt ? new Date(ix.checkedAt).toLocaleTimeString() : "—"}</span>
          </Descriptions.Item>
          <Descriptions.Item label="原因" span={2}>
            {ix.data?.error ? <Typography.Text type="warning">{ix.data.error}</Typography.Text> : "—"}
          </Descriptions.Item>
        </Descriptions>
      </Section>

      <Section title="运行时版本">
        {version.error ? (
          <Alert type="error" showIcon message="读取版本失败" description={version.error} />
        ) : (
          <Descriptions {...DESC_PROPS} column={{ xs: 1, md: 2, xl: 3 }}>
            <Descriptions.Item label="应用">
              {version.data ? `${version.data.appName} ${version.data.appVersion}` : version.loading ? "读取中..." : "—"}
            </Descriptions.Item>
            <Descriptions.Item label="Electron">{version.data?.electron ?? "—"}</Descriptions.Item>
            <Descriptions.Item label="Chrome">{version.data?.chrome ?? "—"}</Descriptions.Item>
            <Descriptions.Item label="Node（主进程）">{version.data?.node ?? "—"}</Descriptions.Item>
            <Descriptions.Item label="平台">
              {version.data ? `${version.data.platform} / ${version.data.arch}` : "—"}
            </Descriptions.Item>
            <Descriptions.Item label="数据目录" span="filled">
              {version.data ? <Typography.Text copyable>{version.data.dataRoot}</Typography.Text> : "—"}
            </Descriptions.Item>
          </Descriptions>
        )}
      </Section>
    </Panel>
  );
}
