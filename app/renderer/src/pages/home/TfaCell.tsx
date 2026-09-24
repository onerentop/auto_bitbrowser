/**
 * 首页 2FA：验证码取数 hook + 表格单元格
 *
 * 密钥只在后端。这里按窗口 ID 向后端要验证码，在每个 30 秒周期结束后自动再要一次；
 * 单元格自己每秒走倒计时（只有可视区域的几十个单元格在跑，不会让整张表每秒重渲染）。
 */
import { useEffect, useState, type ReactElement } from "react";
import { App, Progress, Space, Tooltip, Typography } from "antd";
import { MAX_TFA_CODE_IDS, type HomeTfaCodes } from "../../../../shared/channels/home.ts";
import { IPC, invoke } from "../../lib/ipc.ts";

const PERIOD_SECONDS = 30;

/**
 * 取 ids 对应的当前验证码。ids 或 version（列表刷新次数）变化时立即重取；
 * 之后在 periodEndsAt 后 300ms 自动重取；出错 5 秒后重试。
 */
export function useTfaCodes(ids: readonly number[], version: number): HomeTfaCodes | null {
  const idsKey = ids.slice(0, MAX_TFA_CODE_IDS).join(",");
  const [data, setData] = useState<HomeTfaCodes | null>(null);

  useEffect(() => {
    if (!idsKey) {
      setData(null);
      return;
    }
    const list = idsKey.split(",").map(Number);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      try {
        const res = await invoke(IPC.invoke.homeTfaCodes, list);
        if (cancelled) return;
        setData(res);
        timer = setTimeout(() => void load(), Math.max(500, res.periodEndsAt - Date.now() + 300));
      } catch {
        if (!cancelled) timer = setTimeout(() => void load(), 5000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [idsKey, version]);

  return data;
}

/** 距 periodEndsAt 还剩几秒（每秒更新） */
function useSecondsLeft(periodEndsAt: number | null): number {
  const calc = (): number =>
    periodEndsAt === null ? 0 : Math.max(0, Math.min(PERIOD_SECONDS, Math.ceil((periodEndsAt - Date.now()) / 1000)));
  const [left, setLeft] = useState(calc);
  useEffect(() => {
    setLeft(calc());
    if (periodEndsAt === null) return;
    const t = setInterval(() => setLeft(calc()), 1000);
    return () => clearInterval(t);
    // calc 只依赖 periodEndsAt
  }, [periodEndsAt]);
  return left;
}

export interface TfaCellProps {
  hasTfa: boolean;
  code: string | undefined;
  invalid: boolean;
  periodEndsAt: number | null;
}

export function TfaCell({ hasTfa, code, invalid, periodEndsAt }: TfaCellProps): ReactElement {
  const { message } = App.useApp();
  const left = useSecondsLeft(code ? periodEndsAt : null);

  if (!hasTfa) return <Typography.Text type="secondary">—</Typography.Text>;
  if (invalid) return <Typography.Text type="warning">密钥无效</Typography.Text>;
  if (!code) return <Typography.Text type="secondary">…</Typography.Text>;

  const copy = (): void => {
    navigator.clipboard.writeText(code).then(
      () => void message.success(`验证码 ${code} 已复制`),
      () => void message.error("复制失败"),
    );
  };
  const urgent = left <= 5;

  return (
    <Tooltip title="点击复制验证码">
      <Space
        size={6}
        style={{ cursor: "pointer", userSelect: "none" }}
        onClick={copy}
        // 双击行 = 打开窗口；在验证码上双击只复制，不打开
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <Typography.Text strong style={{ fontFamily: "Consolas, monospace", fontSize: 15, letterSpacing: 1 }} type={urgent ? "danger" : undefined}>
          {code.slice(0, 3)} {code.slice(3)}
        </Typography.Text>
        <Progress
          type="circle"
          size={16}
          percent={(left / PERIOD_SECONDS) * 100}
          showInfo={false}
          strokeColor={urgent ? "#ff4d4f" : undefined}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12, width: 22 }}>
          {left}s
        </Typography.Text>
      </Space>
    </Tooltip>
  );
}
