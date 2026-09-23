/**
 * BrowserUse Engine - DOM 序列化（Node 重写）
 * 对标 core/browseruse_engine/dom/serializer.py
 *
 * 移植差异：
 *   - 构造参数由 Python 的关键字参数改成可选配置对象，键名保留 snake_case
 *     （include_attributes / max_text_length / max_elements），默认值与 Python 一致
 *   - 字符串切片：Python 按 Unicode 码点切，JS 的 slice 按 UTF-16 码元切，
 *     超 BMP 字符（emoji 等）的截断位置可能差 1，非 ASCII 中文不受影响
 *   - 输出文本逐字对齐（前缀 `*`、`...` 省略号、`... and N more elements`），
 *     属性白名单与 30 字符截断长度原样保留
 */

import type { DOMElement, DOMTree } from "../types.ts";

/** DOMSerializer 构造选项 —— 对标 DOMSerializer.__init__ 的三个关键字参数 */
export interface DOMSerializerOptions {
  /** 是否包含元素属性，默认 true */
  include_attributes?: boolean;
  /** 文本最大长度，默认 50 */
  max_text_length?: number;
  /** 最大元素数量，默认 100 */
  max_elements?: number;
}

/**
 * DOM 序列化器 —— 对标 DOMSerializer
 *
 * 将 DOM 树序列化为 LLM 可理解的文本格式。
 *
 * 输出格式示例:
 *     [1] button "Submit"
 *     [2] textbox "Email" placeholder="Enter email"
 *     *[3] link "Learn more" href="/about"    # * 表示新出现的元素
 */
export class DOMSerializer {
  readonly include_attributes: boolean;
  readonly max_text_length: number;
  readonly max_elements: number;

  constructor(options: DOMSerializerOptions = {}) {
    this.include_attributes = options.include_attributes ?? true;
    this.max_text_length = options.max_text_length ?? 50;
    this.max_elements = options.max_elements ?? 100;
  }

  /** 序列化 DOM 树为文本 —— 对标 serialize() */
  serialize(domTree: DOMTree): string {
    const lines: string[] = [];
    const elements = domTree.elements.slice(0, this.max_elements);

    for (const element of elements) {
      const line = this.serializeElement(element);
      lines.push(line);
    }

    if (domTree.elements.length > this.max_elements) {
      lines.push(`... and ${domTree.elements.length - this.max_elements} more elements`);
    }

    return lines.join("\n");
  }

  /** 序列化单个元素 —— 对标 serialize_element() */
  serializeElement(element: DOMElement): string {
    const parts: string[] = [];

    // 新元素标记
    const prefix = element.is_new ? "*" : "";

    // 索引和标签
    parts.push(`${prefix}[${element.index}]`);
    parts.push(element.tag_name);

    // 文本内容
    if (element.text) {
      let text = element.text.slice(0, this.max_text_length);
      if (element.text.length > this.max_text_length) {
        text += "...";
      }
      parts.push(`"${text}"`);
    }

    // 角色
    if (element.role && element.role.toLowerCase() !== element.tag_name.toLowerCase()) {
      parts.push(`role=${element.role}`);
    }

    // 属性
    if (this.include_attributes) {
      const attrParts = this.serializeAttributes(element);
      parts.push(...attrParts);
    }

    return parts.join(" ");
  }

  /** 序列化元素属性 —— 对标 _serialize_attributes()（私有，这里保留 protected 可见性） */
  protected serializeAttributes(element: DOMElement): string[] {
    const parts: string[] = [];
    const priorityAttrs = ["placeholder", "value", "href", "type", "name", "src"];

    for (const attr of priorityAttrs) {
      // Python: `if attr in element.attributes and element.attributes[attr]`
      const raw = element.attributes[attr];
      if (raw !== undefined && raw) {
        let value = raw;
        if (value.length > 30) {
          value = value.slice(0, 30) + "...";
        }
        parts.push(`${attr}="${value}"`);
      }
    }

    return parts;
  }

  /** 紧凑格式序列化 (节省 token) —— 对标 serialize_compact() */
  serializeCompact(domTree: DOMTree): string {
    const lines: string[] = [];
    const elements = domTree.elements.slice(0, this.max_elements);

    for (const element of elements) {
      // 紧凑格式: [index] tag "text"
      const prefix = element.is_new ? "*" : "";
      const text = element.text ? element.text.slice(0, 30) : "";
      if (text) {
        lines.push(`${prefix}[${element.index}] ${element.tag_name} "${text}"`);
      } else {
        lines.push(`${prefix}[${element.index}] ${element.tag_name}`);
      }
    }

    return lines.join("\n");
  }
}

// ==================== 全局序列化器 ====================

const defaultSerializer = new DOMSerializer();

/** 序列化 DOM 树 —— 对标模块级函数 serialize_dom() */
export function serializeDom(domTree: DOMTree, compact = false): string {
  if (compact) {
    return defaultSerializer.serializeCompact(domTree);
  }
  return defaultSerializer.serialize(domTree);
}
