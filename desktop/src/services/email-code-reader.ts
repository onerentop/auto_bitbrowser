/**
 * Gmail IMAP 验证码读取（Node 重写）
 * 对标 services/email_code_reader.py
 *
 * 依赖差异：Python 用 imap_tools，Node 侧用 imapflow。
 * 验证码提取是纯函数（extractCodeFromEmail），已与 Python 逐用例对拍。
 *
 * 筛选规则（与 Python 一致，顺序不可调整）：
 *   1. 只取最近 1 天的邮件，倒序，每轮最多 20 封
 *   2. 跳过本轮已检查过的 UID
 *   3. 发件人须命中 GOOGLE_SENDER_PATTERNS 之一（子串、大小写不敏感）
 *   4. 邮件年龄超过 lookbackMinutes 的跳过
 *   5. 正文优先 text，回退 html
 */

export const GMAIL_IMAP_SERVER = "imap.gmail.com";
export const GMAIL_IMAP_PORT = 993;

/** Google 验证码可能的发件地址片段 */
export const GOOGLE_SENDER_PATTERNS = [
  "noreply@google.com",
  "no-reply@accounts.google.com",
  "noreply@accounts.google.com",
  "google.com",
];

/**
 * 从邮件正文提取 6 位验证码。
 * 三个模式按优先级依次尝试，命中即返回第一个捕获组。
 */
export function extractCodeFromEmail(emailBody: string): string | null {
  if (!emailBody) return null;

  // 去 HTML 标签（与 Python 的 re.sub(r'<[^>]+>', ' ', ...) 等价）
  const text = emailBody.replace(/<[^>]+>/g, " ");

  const patterns: RegExp[] = [
    /(?:code|verification code|验证码|確認碼)[:\s]*(\d{6})/i,
    /(\d{6})(?:\s+is your|是您的)/i,
    /\b(\d{6})\b/i,
  ];

  for (const re of patterns) {
    const m = re.exec(text);
    if (m && m[1]) return m[1];
  }
  return null;
}

/** 判断发件人是否来自 Google */
export function isFromGoogle(sender: string | null | undefined): boolean {
  if (!sender) return false;
  const s = sender.toLowerCase();
  return GOOGLE_SENDER_PATTERNS.some((p) => s.includes(p.toLowerCase()));
}

export interface GmailCodeReaderOptions {
  email: string;
  /** Gmail 应用专用密码，非登录密码 */
  password: string;
  /** SOCKS5 代理（可选） */
  proxyHost?: string;
  proxyPort?: number;
}

export interface FetchCodeOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  lookbackMinutes?: number;
  onProgress?: (message: string) => void;
}

/** 抽象邮件，便于把轮询逻辑与具体 IMAP 库解耦 */
export interface MailMessage {
  uid: string;
  from: string | null;
  subject: string | null;
  date: Date | null;
  text: string | null;
  html: string | null;
}

/** 邮件源抽象：真实实现用 imapflow，测试用内存实现 */
export interface MailSource {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** 拉取最近 sinceDays 天的邮件，倒序，最多 limit 封 */
  fetchRecent(sinceDays: number, limit: number): Promise<MailMessage[]>;
}

/** 把连接错误归类成中文提示，对标 Python connect() 的分支 */
export function classifyConnectError(message: string): string {
  if (message.includes("Invalid credentials") || message.includes("AUTHENTICATIONFAILED")) {
    return "认证失败: 请检查邮箱和应用专用密码是否正确";
  }
  if (message.includes("Connection refused")) {
    return "连接被拒绝: 请检查网络连接或代理设置";
  }
  if (message.includes("SOCKS") || message.toLowerCase().includes("proxy")) {
    return `代理连接失败: ${message}`;
  }
  return `连接失败: ${message}`;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 轮询读取验证码。
 * 与具体 IMAP 实现解耦——传入任意 MailSource 即可。
 */
export async function fetchVerificationCode(
  source: MailSource,
  options: FetchCodeOptions & { sleepImpl?: (ms: number) => Promise<void> } = {},
): Promise<[boolean, string]> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const lookbackMinutes = options.lookbackMinutes ?? 5;
  const sleep = options.sleepImpl ?? defaultSleep;

  const start = Date.now();
  const checkedUids = new Set<string>();

  while (Date.now() - start < timeoutMs) {
    try {
      const messages = await source.fetchRecent(1, 20);

      for (const msg of messages) {
        if (checkedUids.has(msg.uid)) continue;
        checkedUids.add(msg.uid);

        if (!isFromGoogle(msg.from)) continue;

        // 邮件太旧则跳过
        if (msg.date) {
          const ageMinutes = (Date.now() - msg.date.getTime()) / 60_000;
          if (ageMinutes > lookbackMinutes) continue;
        }

        const code = extractCodeFromEmail(msg.text || msg.html || "");
        if (code) return [true, code];
      }

      if (options.onProgress) {
        const elapsed = Math.floor((Date.now() - start) / 1000);
        options.onProgress(
          `未找到验证码，${Math.floor(pollIntervalMs / 1000)}s 后重试... (已等待 ${elapsed}s/${Math.floor(timeoutMs / 1000)}s)`,
        );
      }
      await sleep(pollIntervalMs);
    } catch (err) {
      // 出错时尝试重连一次，失败则终止（与 Python 一致）
      const msg = err instanceof Error ? err.message : String(err);
      options.onProgress?.(`读取邮件出错: ${msg}`);
      try {
        await source.disconnect();
        await source.connect();
      } catch (reconnectErr) {
        const rm = reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr);
        return [false, `重连失败: ${classifyConnectError(rm)}`];
      }
    }
  }

  return [false, `超时: ${Math.floor(timeoutMs / 1000)}s 内未收到验证码`];
}