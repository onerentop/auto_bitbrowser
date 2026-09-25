/**
 * 代理连通性检测（只读，纯 Node，不依赖 Electron）
 *
 * 做法：与代理建立 TCP 连接 → 按类型完成隧道握手（HTTP CONNECT / SOCKS5）→ 在隧道里
 * 明文 GET 一个回显 IP 的地址 → 把响应体里的 IPv4 当作**出站 IP**。拿到 IP 才算连接可用。
 *
 * 为什么不用 `fetch(url, { proxy })`（真机实测 2026-09-26）：
 *   - 代理不可达时 fetch 会**静默直连**并返回 200，实测 `proxy: http://127.0.0.1:9` 仍得 200 + 本机 IP
 *     —— 那会给出假绿灯，正是状态灯最不能犯的错；
 *   - 手写隧道在同样条件下 3ms 内 ECONNREFUSED，能真实区分「经代理出网」与「直连」。
 *
 * 探测目标默认 http://api.ipify.org（明文 80 口，无需 TLS，响应体就是一个 IP）。
 * 网络/代理都不可用时返回 ok:false + 原因：那是**真实结果**，不是错误。
 */
import net from "node:net";

/** 默认超时（毫秒） */
export const PROXY_CHECK_DEFAULT_TIMEOUT_MS = 8000;

/** 默认探测目标：明文回显出站 IP */
export const PROXY_CHECK_DEFAULT_TARGET = { host: "api.ipify.org", port: 80 } as const;

/** 代理条目（与 ProxyInfo 同形，避免这里 import 上层类型） */
export interface ProxyCheckInput {
  proxy_type: string;
  host: string;
  port: string | number;
  username: string;
  password: string;
}

export interface ProxyCheckOutcome {
  ok: boolean;
  /** 出站 IP；失败时为 null */
  outbound_ip: string | null;
  /** 失败原因（截断到 200 字符）；成功时为 null */
  error: string | null;
}

export interface ProxyCheckTarget {
  host: string;
  port: number;
}

/** 本模块用到的最小 socket 面（便于单测注入假实现） */
export interface ProxyCheckSocket {
  write(data: Buffer | string): unknown;
  destroy(): void;
  on(event: "connect" | "data" | "error" | "close", listener: (...args: unknown[]) => void): unknown;
}

export interface ProxyCheckOptions {
  /** 建立到代理的 TCP 连接（默认 node:net） */
  connect?: (port: number, host: string) => ProxyCheckSocket;
  timeoutMs?: number;
  target?: ProxyCheckTarget;
  /** 超时定时器（单测注入可立刻触发） */
  setTimeoutImpl?: (callback: () => void, ms: number) => unknown;
}

/** 错误文本上限：代理/网络的原因可能很长，截断后再入库存库与显示 */
const MAX_ERROR_LENGTH = 200;

function truncate(text: string): string {
  const t = text.trim();
  return t.length > MAX_ERROR_LENGTH ? `${t.slice(0, MAX_ERROR_LENGTH)}…` : t;
}

/** 从响应文本里取第一个合法 IPv4（每段 ≤ 255），取不到返回 null */
export function parseOutboundIp(text: string): string | null {
  const m = text.match(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/);
  if (!m) return null;
  const parts = m.slice(1).map((s) => Number(s));
  if (parts.some((n) => n > 255)) return null;
  return parts.join(".");
}

function base64(input: string): string {
  return Buffer.from(input, "utf8").toString("base64");
}

/** 在隧道里请求目标，返回响应全文（HTTP 头 + 体） */
function targetRequestText(target: ProxyCheckTarget): string {
  return `GET / HTTP/1.1\r\nHost: ${target.host}\r\nUser-Agent: abb-proxy-check\r\nAccept: */*\r\nConnection: close\r\n\r\n`;
}

/**
 * 探测一个代理。任何异常都折算成 ok:false（探测失败不是抛错场景）。
 */
export function checkProxy(input: ProxyCheckInput, options: ProxyCheckOptions = {}): Promise<ProxyCheckOutcome> {
  const connect =
    options.connect ??
    ((port: number, host: string) => net.connect(port, host) as unknown as ProxyCheckSocket);
  const timeoutMs = options.timeoutMs ?? PROXY_CHECK_DEFAULT_TIMEOUT_MS;
  const target = options.target ?? PROXY_CHECK_DEFAULT_TARGET;
  const setTimer = options.setTimeoutImpl ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));

  const port = Number(input.port);
  if (!input.host || !Number.isFinite(port) || port <= 0) {
    return Promise.resolve({ ok: false, outbound_ip: null, error: "代理主机或端口无效" });
  }

  return new Promise<ProxyCheckOutcome>((resolve) => {
    let settled = false;
    let timer: unknown = null;
    let socket: ProxyCheckSocket | null = null;
    /** 累积的字节：HTTP 用 latin1 文本拼接，SOCKS5 用 Buffer 拼接 */
    let textBuf = "";
    let binBuf = Buffer.alloc(0);
    let stage = "";

    const finish = (outcome: ProxyCheckOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer as NodeJS.Timeout);
      try {
        socket?.destroy();
      } catch {
        /* 关连接失败无所谓 */
      }
      resolve(outcome);
    };
    const fail = (error: string): void => finish({ ok: false, outbound_ip: null, error: truncate(error) });
    const succeed = (ip: string): void => finish({ ok: true, outbound_ip: ip, error: null });
    const send = (data: Buffer | string): void => {
      socket?.write(data);
    };

    /** 拿到响应**全文**后判定：有 IP 算成功，没有才算失败（只在连接关闭 / 超时时调用） */
    const settleByBody = (body: string): void => {
      const ip = parseOutboundIp(body);
      if (ip) succeed(ip);
      else fail(`响应里没有出站 IP：${body.slice(0, 80)}`);
    };

    /**
     * GET 阶段的数据到达：**只在真的解析出 IP 时**判成功。
     * 不能凭当前片段判失败 —— socket 的 data 事件不保证消息边界，
     * 头部与正文可能分两次到达（审查发现：先到头部时会被误判成「没有出站 IP」）。
     */
    const maybeSucceedByBody = (body: string): void => {
      const ip = parseOutboundIp(body);
      if (ip) succeed(ip);
    };

    try {
      socket = connect(port, input.host);
    } catch (error) {
      fail(`连接代理失败: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    timer = setTimer(() => fail(`超时（${timeoutMs}ms）`), timeoutMs);

    socket.on("error", (error: unknown) => {
      const e = error as NodeJS.ErrnoException | undefined;
      fail(`${e?.code ?? "网络错误"}: ${e?.message ?? String(error)}`);
    });
    socket.on("close", () => {
      if (settled) return;
      // GET 阶段关闭 = 响应收完了：这时还没有 IP，才可以如实判失败
      if (stage === "GET") settleByBody(textBuf);
      else fail(`连接在「${stage || "握手"}」阶段被关闭`);
    });

    const isSocks5 = String(input.proxy_type).toLowerCase().startsWith("socks");

    // ==================== HTTP / HTTPS 代理：明文 CONNECT 隧道 ====================
    if (!isSocks5) {
      socket.on("connect", () => {
        stage = "CONNECT";
        const auth =
          input.username || input.password
            ? `Proxy-Authorization: Basic ${base64(`${input.username}:${input.password}`)}\r\n`
            : "";
        send(
          `CONNECT ${target.host}:${target.port} HTTP/1.1\r\n` +
            `Host: ${target.host}:${target.port}\r\n` +
            `${auth}` +
            `\r\n`,
        );
      });

      socket.on("data", (chunk: unknown) => {
        textBuf += Buffer.isBuffer(chunk) ? chunk.toString("latin1") : String(chunk);
        if (stage === "CONNECT") {
          const end = textBuf.indexOf("\r\n\r\n");
          if (end < 0) return;
          const statusLine = textBuf.slice(0, textBuf.indexOf("\r\n"));
          if (!/^HTTP\/1\.[01]\s+2\d\d/.test(statusLine)) {
            fail(`代理拒绝隧道：${statusLine}`);
            return;
          }
          textBuf = textBuf.slice(end + 4);
          stage = "GET";
          send(targetRequestText(target));
          return;
        }
        maybeSucceedByBody(textBuf);
      });
      return;
    }

    // ==================== SOCKS5 ====================
    const hasCredential = Boolean(input.username) || Boolean(input.password);
    socket.on("connect", () => {
      stage = "方法协商";
      send(Buffer.from([5, 1, hasCredential ? 2 : 0]));
    });

    socket.on("data", (chunk: unknown) => {
      if (Buffer.isBuffer(chunk)) binBuf = Buffer.concat([binBuf, chunk]);
      else binBuf = Buffer.concat([binBuf, Buffer.from(String(chunk), "latin1")]);

      if (stage === "方法协商") {
        if (binBuf.length < 2) return;
        const method = binBuf[1];
        if (method === 0xff) {
          fail("代理拒绝了认证方式");
          return;
        }
        binBuf = Buffer.alloc(0);
        if (method === 2) {
          stage = "认证";
          const u = Buffer.from(input.username ?? "", "utf8");
          const p = Buffer.from(input.password ?? "", "utf8");
          send(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
          return;
        }
        stage = "CONNECT";
        const host = Buffer.from(target.host, "utf8");
        send(
          Buffer.concat([
            Buffer.from([5, 1, 0, 3, host.length]),
            host,
            Buffer.from([target.port >> 8, target.port & 0xff]),
          ]),
        );
        return;
      }

      if (stage === "认证") {
        if (binBuf.length < 2) return;
        const status = binBuf[1];
        if (status !== 0) {
          fail("用户名或密码被代理拒绝");
          return;
        }
        binBuf = Buffer.alloc(0);
        stage = "CONNECT";
        const host = Buffer.from(target.host, "utf8");
        send(
          Buffer.concat([
            Buffer.from([5, 1, 0, 3, host.length]),
            host,
            Buffer.from([target.port >> 8, target.port & 0xff]),
          ]),
        );
        return;
      }

      if (stage === "CONNECT") {
        if (binBuf.length < 10) return;
        const reply = binBuf[1];
        if (reply !== 0) {
          fail(`SOCKS5 连接目标失败（reply=${reply}）`);
          return;
        }
        binBuf = Buffer.alloc(0);
        stage = "GET";
        send(targetRequestText(target));
        return;
      }

      // GET 阶段：把响应累积到 textBuf（与 HTTP 分支共用），拿到 IP 才判成功
      textBuf += binBuf.toString("latin1");
      binBuf = Buffer.alloc(0);
      maybeSucceedByBody(textBuf);
    });
  });
}
