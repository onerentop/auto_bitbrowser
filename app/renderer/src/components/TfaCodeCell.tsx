/**
 * 2FA 验证码的共享取数 hook 与表格单元格（首页按窗口 ID、账号页按邮箱都用它）
 *
 * 密钥只在后端。这里按 key 向后端要验证码，在每个 30 秒周期结束后自动再要一次；
 * 单元格自己每秒走倒计时（只有可视区域的几十个单元格在跑，不会让整张表每秒重渲染）。
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { App, Progress, Space, Tooltip, Typography } from "antd";
import { MAX_TFA_CODE_IDS } from "../../../shared/channels/home.ts";
import { useTokens } from "../theme/tokens.ts";

const PERIOD_SECONDS = 30;

/**
 * 取 keys 对应的当前验证码；keys 或 version（列表刷新次数）变化时立即重取，
 * 之后在 periodEndsAt 后 300ms 自动重取，出错 5 秒后重试。
 *
 * keys 只用来判断「变没变」，真正的请求由调用方给的 fetch 决定（首页传窗口 ID、账号页传邮箱）。
 */
export function useTfaCodes<K extends string | number, D extends { periodEndsAt: number }>(
  keys: readonly K[],
  version: number,
  fetch: (keys: string[]) => Promise<D>,
): D | null {
  const keysKey = keys.slice(0, MAX_TFA_CODE_IDS).join(",");
  const [data, setData] = useState<D | null>(null);
  // fetch 是实现细节（每个页面固定用一条通道），不进依赖数组，避免每次渲染重取
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;

  useEffect(() => {
    if (!keysKey) {
      setData(null);
      return;
    }
    const list = keysKey.split(",");
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      try {
        const res = await fetchRef.current(list);
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
  }, [keysKey, version]);

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
  /** 有没有配 2FA 密钥（没有时显示「—」） */
  hasTfa: boolean;
  code: string | undefined;
  invalid: boolean;
  periodEndsAt: number | null;
}

export function TfaCell({ hasTfa, code, invalid, periodEndsAt }: TfaCellProps): ReactElement {
  const { message } = App.useApp();
  const t = useTokens();
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
  // 最后 5 秒：验证码与倒计时圈改用 warn 色，提示马上要换新码
  const urgent = left <= 5;

  return (
    <Tooltip title="点击复制验证码">
      <Space
        // 点这一格只复制验证码，不切换行选中
        data-no-row-select
        size={8}
        style={{ cursor: "pointer", userSelect: "none" }}
        onClick={copy}
        // 双击行 = 打开窗口；在验证码上双击只复制，不打开
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <Typography.Text strong className="abb-mono" style={{ fontSize: 14, letterSpacing: 1 }} type={urgent ? "warning" : undefined}>
          {code.slice(0, 3)} {code.slice(3)}
        </Typography.Text>
        <Progress
          type="circle"
          size={16}
          percent={(left / PERIOD_SECONDS) * 100}
          showInfo={false}
          strokeColor={urgent ? t.warn : t.indigo}
          trailColor={t.line}
        />
        <Typography.Text type="secondary" className="abb-num" style={{ fontSize: 12, width: 22 }}>
          {left}s
        </Typography.Text>
      </Space>
    </Tooltip>
  );
}
