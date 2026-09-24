/**
 * Python 标准库行为的最小移植 —— 仅供 totp-extractor 使用
 *
 * migration_decoder.py 依赖 urllib.parse / base64 的若干细节（'+' 变空格、
 * 非 Base64 字符被丢弃、padding 报错文案……），这些细节直接决定解析结果与错误信息，
 * 用 WHATWG URL / atob 替代会与 Python 对不上（对拍夹具覆盖了这些分支）。
 */

const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** bytes.decode("utf-8", errors="replace")；ignoreBOM 保证不吞掉开头的 BOM（Python 不吞） */
export function decodeUtf8Replace(bytes: Uint8Array): string {
  return UTF8.decode(bytes);
}

function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}

/**
 * urllib.parse.unquote(string)（encoding=utf-8, errors=replace）。
 * ASCII 片段里的 %XX 转成字节后按 UTF-8 解码；非法的 % 原样保留；非 ASCII 字符原样保留。
 */
export function pyUnquote(s: string): string {
  if (!s.includes("%")) return s;
  let out = "";
  let buf: number[] = [];
  const flush = (): void => {
    if (buf.length) out += decodeUtf8Replace(Uint8Array.from(buf));
    buf = [];
  };
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 0x7f) {
      flush();
      out += s[i];
      continue;
    }
    if (code === 0x25 && i + 2 < s.length) {
      const h = hexVal(s.charCodeAt(i + 1));
      const l = hexVal(s.charCodeAt(i + 2));
      if (h >= 0 && l >= 0) {
        buf.push(h * 16 + l);
        i += 2;
        continue;
      }
    }
    buf.push(code);
  }
  flush();
  return out;
}

/**
 * urllib.parse.parse_qs(query)（keep_blank_values=False, strict_parsing=False, separator="&"）：
 * 无 "=" 的片段与空值被丢弃；键和值都先把 "+" 换成空格再 unquote。
 */
export function pyParseQs(query: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const rawValue = pair.slice(eq + 1);
    if (rawValue.length === 0) continue;
    const name = pyUnquote(pair.slice(0, eq).replace(/\+/g, " "));
    const value = pyUnquote(rawValue.replace(/\+/g, " "));
    const list = out.get(name);
    if (list) list.push(value);
    else out.set(name, [value]);
  }
  return out;
}

export interface PySplitResult {
  scheme: string;
  netloc: string;
  path: string;
  query: string;
  fragment: string;
}

const SCHEME_CHARS = /^[A-Za-z0-9+\-.]+$/;

/**
 * urllib.parse.urlparse(uri) 的 scheme/netloc/path/query/fragment 部分（Python 3.13 urlsplit）。
 * otpauth / otpauth-migration 不在 uses_params 里，所以不拆 ;params。
 */
export function pyUrlSplit(input: string): PySplitResult {
  // lstrip(_WHATWG_C0_CONTROL_OR_SPACE) + 去掉 \t \r \n
  let url = input.replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, "");
  let scheme = "";
  let netloc = "";
  let query = "";
  let fragment = "";
  const i = url.indexOf(":");
  if (i > 0 && /^[A-Za-z]/.test(url) && SCHEME_CHARS.test(url.slice(0, i))) {
    scheme = url.slice(0, i).toLowerCase();
    url = url.slice(i + 1);
  }
  if (url.startsWith("//")) {
    let delim = url.length;
    for (const c of ["/", "?", "#"]) {
      const w = url.indexOf(c, 2);
      if (w >= 0) delim = Math.min(delim, w);
    }
    netloc = url.slice(2, delim);
    url = url.slice(delim);
    if ((netloc.includes("[") && !netloc.includes("]")) || (netloc.includes("]") && !netloc.includes("["))) {
      throw new Error("Invalid IPv6 URL");
    }
  }
  const hash = url.indexOf("#");
  if (hash >= 0) {
    fragment = url.slice(hash + 1);
    url = url.slice(0, hash);
  }
  const q = url.indexOf("?");
  if (q >= 0) {
    query = url.slice(q + 1);
    url = url.slice(0, q);
  }
  return { scheme, netloc, path: url, query, fragment };
}

/** Python int(str)：允许首尾空白、正负号、数字间单个下划线；否则抛与 Python 同文案的错误 */
export function pyInt(s: string): number {
  const m = /^\s*([+-]?)(\d+(?:_\d+)*)\s*$/.exec(s);
  if (!m) throw new Error(`invalid literal for int() with base 10: '${s}'`);
  const n = Number((m[2] ?? "").replace(/_/g, ""));
  return m[1] === "-" ? -n : n;
}

const B64_TABLE: Int8Array = (() => {
  const t = new Int8Array(128).fill(-1);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < alphabet.length; i++) t[alphabet.charCodeAt(i)] = i;
  return t;
})();

/**
 * base64.b64decode(s)（validate=False）= binascii.a2b_base64 非严格模式：
 *   - 非 ASCII 字符串直接报错
 *   - 不在字母表里的字符被丢弃
 *   - 遇到足够的 "=" 立即结束（后面的内容忽略）
 *   - 结束时剩 1 个字符 / 2~3 个字符分别报两种错
 */
export function pyB64Decode(s: string): Uint8Array {
  if (!/^[\x00-\x7f]*$/.test(s)) throw new Error("string argument should contain only ASCII characters");
  const out: number[] = [];
  let quadPos = 0;
  let leftchar = 0;
  let pads = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 0x3d) {
      pads += 1;
      if (quadPos >= 2 && quadPos + pads >= 4) return Uint8Array.from(out);
      continue;
    }
    const v = B64_TABLE[ch] ?? -1;
    if (v < 0) continue;
    pads = 0;
    switch (quadPos) {
      case 0:
        quadPos = 1;
        leftchar = v;
        break;
      case 1:
        quadPos = 2;
        out.push(((leftchar << 2) | (v >> 4)) & 0xff);
        leftchar = v & 0x0f;
        break;
      case 2:
        quadPos = 3;
        out.push(((leftchar << 4) | (v >> 2)) & 0xff);
        leftchar = v & 0x03;
        break;
      default:
        quadPos = 0;
        out.push(((leftchar << 6) | v) & 0xff);
        leftchar = 0;
    }
  }
  if (quadPos === 1) {
    const count = (Math.floor(out.length / 3) * 4) + 1;
    throw new Error(
      `Invalid base64-encoded string: number of data characters (${count}) cannot be 1 more than a multiple of 4`,
    );
  }
  if (quadPos !== 0) throw new Error("Incorrect padding");
  return Uint8Array.from(out);
}

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** base64.b32encode(raw).decode("ascii").rstrip("=") */
export function b32EncodeNoPad(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}
