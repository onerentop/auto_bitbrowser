/**
 * 账号数据行解析/构建
 *
 * 解析要点（顺序不可调整）：
 *   1. 去注释：仅当 # 前面是空格/Tab 时才截断，避免误伤 URL 里的锚点
 *   2. 抽链接：非贪婪匹配 http(s)://，随后从原行中移除并清理残留分隔符
 *   3. 探分隔符：按 ---- / --- / | / , / ; / \t 的优先级取第一个命中的
 *   4. 定位邮箱：找到含 @ 且域名部分含 . 的字段，其后依次是 密码/辅助邮箱/密钥
 *      找不到邮箱时退化为按位置取前 4 段
 */

export interface ParsedAccount {
  email: string | null;
  password: string | null;
  recovery: string | null;
  secret: string | null;
  link: string | null;
}

const EMPTY: ParsedAccount = {
  email: null,
  password: null,
  recovery: null,
  secret: null,
  link: null,
};

/** 链接匹配：非贪婪，遇到分隔符或行尾停止 */
const URL_PATTERN = /(https?:\/\/[^\s\-|,;]+?)(?=\s*-{2,}|\s*\||\s*,|\s*;|\s*$)/;

const SEPARATORS = ["----", "---", "|", ",", ";", "\t"] as const;

export function parseAccountLine(rawLine: string): ParsedAccount {
  if (!rawLine) return { ...EMPTY };

  let line = rawLine.trim();

  // Step 0: 移除注释（# 前必须是空格或 Tab，否则视为 URL 的一部分）
  const commentIdx = line.indexOf("#");
  if (commentIdx > 0) {
    const prev = line[commentIdx - 1];
    if (prev === " " || prev === "\t") {
      line = line.slice(0, commentIdx).trim();
    }
  }
  if (!line) return { ...EMPTY };

  // Step 1: 提取链接并从原行移除
  let link: string | null = null;
  const m = URL_PATTERN.exec(line);
  if (m) {
    link = (m[1] ?? "").trim();
    line = line.replace(m[0], "").trim();
    // 移除开头残留的分隔符
    line = line.replace(/^-{2,}/, "").trim();
  }

  // Step 2: 探测分隔符，默认 ----
  let separator: string = "----";
  for (const sep of SEPARATORS) {
    if (line.includes(sep)) {
      separator = sep;
      break;
    }
  }

  // Step 3: 分割并丢弃空段
  const parts = line
    .split(separator)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // Step 4: 定位邮箱
  let email: string | null = null;
  let password: string | null = null;
  let recovery: string | null = null;
  let secret: string | null = null;

  let emailIdx = -1;
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i] as string;
    if (p.includes("@")) {
      const domain = p.split("@").pop() ?? "";
      if (domain.includes(".")) {
        emailIdx = i;
        break;
      }
    }
  }

  if (emailIdx >= 0) {
    email = parts[emailIdx] ?? null;
    const remaining = parts.slice(emailIdx + 1);
    password = remaining[0] ?? null;
    recovery = remaining[1] ?? null;
    secret = remaining[2] ?? null;
  } else if (parts.length >= 1) {
    // 没找到邮箱：按位置顺序分配（兼容旧数据）
    email = parts[0] ?? null;
    password = parts[1] ?? null;
    recovery = parts[2] ?? null;
    secret = parts[3] ?? null;
  }

  return { email, password, recovery, secret, link };
}

/**
 * 构建账号行。
 * 规则：保持 email----password----recovery----secret 四段，
 * 从末尾裁掉连续空值但至少保留 2 段；有链接时前置。
 */
export function buildAccountLine(options: {
  email: string | null | undefined;
  password?: string | null;
  recovery?: string | null;
  secret?: string | null;
  link?: string | null;
  separator?: string;
}): string {
  const separator = options.separator ?? "----";
  const parts: string[] = [
    options.email ?? "",
    options.password ?? "",
    options.recovery ?? "",
    options.secret ?? "",
  ];

  while (parts.length > 2 && !parts[parts.length - 1]) {
    parts.pop();
  }

  let line = parts.join(separator);
  if (options.link) line = `${options.link}${separator}${line}`;
  return line;
}