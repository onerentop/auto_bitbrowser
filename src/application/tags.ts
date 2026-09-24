/**
 * ixBrowser 标签的纯逻辑（可单测）
 *
 * 关键事实（真机实测 2026-09-25，样本 374 窗口 / 37 标签）：
 *   - 窗口上的 `tag_id` 是**空格分隔**的多个 id（`142399 140180`），空值是空串；
 *   - `tag_name` 同样是空格分隔的名字，但**标签标题本身可能含空格**
 *     （实测有 `Google Cloud不可用`），所以**绝不能按空格解析 tag_name**；
 *   - 因此：**读**一律用 `tag_id` + `tag-list` 词表映射出标题与颜色；**写**用词表里的标题数组
 *     （官方文档：profile-update 的 `tag` 字段，多标签传数组）。
 */
import type { IxTag } from "../ixbrowser/types.ts";

/** tag_id 原始值 → 去重正整数数组；空、非字符串、非法项一律丢弃 */
export function parseTagIds(raw: unknown): number[] {
  if (typeof raw === "number") return Number.isInteger(raw) && raw > 0 ? [raw] : [];
  if (typeof raw !== "string") return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const part of raw.trim().split(/\s+/)) {
    if (part === "") continue;
    const n = Number(part);
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** 窗口 ID → 标签 id 列表（直接从原始窗口数组取，不经过 buildBrowserList） */
export function tagIdsByWindow(windows: readonly unknown[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const w of windows) {
    if (w === null || typeof w !== "object" || Array.isArray(w)) continue;
    const o = w as Record<string, unknown>;
    const id = o["profile_id"];
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) continue;
    const ids = parseTagIds(o["tag_id"]);
    if (ids.length > 0) out.set(String(id), ids);
  }
  return out;
}

/** 标签 id → 词表项；词表里没有的 id 直接丢弃（不显示半个标签） */
export function resolveTags(ids: readonly number[], vocabulary: readonly IxTag[]): IxTag[] {
  if (ids.length === 0) return [];
  const byId = new Map(vocabulary.map((t) => [t.id, t]));
  const out: IxTag[] = [];
  for (const id of ids) {
    const t = byId.get(id);
    if (t) out.push(t);
  }
  return out;
}

/** 标签 id → 写窗口用的名字数组（官方接口收标签名）；词表里没有的 id 丢弃 */
export function tagTitles(ids: readonly number[], vocabulary: readonly IxTag[]): string[] {
  return resolveTags(ids, vocabulary).map((t) => t.title);
}

/** 词表里不存在的标签 id（用于写入前校验，避免静默丢标签） */
export function unknownTagIds(ids: readonly number[], vocabulary: readonly IxTag[]): number[] {
  const known = new Set(vocabulary.map((t) => t.id));
  return ids.filter((id) => !known.has(id));
}
