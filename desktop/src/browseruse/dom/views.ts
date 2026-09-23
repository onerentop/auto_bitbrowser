/**
 * BrowserUse Engine - DOM 视图模型（Node 重写）
 * 对标 core/browseruse_engine/dom/views.py
 *
 * 移植差异：
 *   - DOMElement / DOMTree / Rect 主体定义在 ../types.ts（对标 types.py），本文件只补
 *     views.py 独有的扩展类型，不重复定义
 *   - Python 的 dataclass → TS 接口 + createXxx() 工厂（字段全必需，工厂给默认值，
 *     覆盖时跳过 undefined），字段名保留 snake_case
 *   - dataclass 上的方法（to_simple / get_selector / get_coordinates / get_element）
 *     → 同名独立函数（TS 接口不携带方法，便于结构化字面量构造）
 *   - Python 的 Dict[int, X] → Map<number, X>（TS 对象键只能是 string）
 *   - Python 的 tuple[float, float] → TS 元组 [number, number]
 *   - Optional[X] → `X | null`；Python dict.get() 缺键返回 None，这里统一成 null
 */

import {
  createDomElement,
  getDomElement,
  type DOMElement,
  type DOMTree,
  type Rect,
} from "../types.ts";

// ==================== 扩展的 DOM 节点 ====================

/** 增强的 DOM 元素，包含额外信息 —— 对标 EnhancedDOMElement（继承 DOMElement） */
export interface EnhancedDOMElement extends DOMElement {
  // 无障碍信息
  aria_label: string;
  aria_role: string;

  // 样式信息
  computed_style: Record<string, string>;
  z_index: number;

  // 层级信息
  depth: number;
  parent_index: number | null;
  children_indices: number[];

  // 交互状态
  is_focused: boolean;
  is_disabled: boolean;
  is_readonly: boolean;
}

export function createEnhancedDomElement(
  overrides: Partial<EnhancedDOMElement> & { index: number; tag_name: string },
): EnhancedDOMElement {
  const base: EnhancedDOMElement = {
    ...createDomElement({ index: overrides.index, tag_name: overrides.tag_name }),
    aria_label: "",
    aria_role: "",
    computed_style: {},
    z_index: 0,
    depth: 0,
    parent_index: null,
    children_indices: [],
    is_focused: false,
    is_disabled: false,
    is_readonly: false,
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (base as unknown as Record<string, unknown>)[k] = v;
  }
  return base;
}

/** 转换为简单的 DOMElement —— 对标 EnhancedDOMElement.to_simple() */
export function enhancedToSimple(el: EnhancedDOMElement): DOMElement {
  return createDomElement({
    index: el.index,
    tag_name: el.tag_name,
    text: el.text,
    // Python: self.role or self.aria_role（空字符串走回退）
    role: el.role || el.aria_role,
    attributes: el.attributes,
    is_interactive: el.is_interactive,
    is_visible: el.is_visible,
    is_new: el.is_new,
    bounding_box: el.bounding_box,
    selector: el.selector,
  });
}

// ==================== 选择器映射 ====================

/**
 * 索引到选择器的映射 —— 对标 SelectorMap
 *
 * 维护元素索引与多种选择器的映射关系，
 * 用于后续的元素定位和操作。
 */
export interface SelectorMap {
  /** index -> CSS 选择器 */
  css_selectors: Map<number, string>;
  /** index -> XPath 选择器 */
  xpath_selectors: Map<number, string>;
  /** index -> 中心坐标 (用于点击) */
  coordinates: Map<number, [number, number]>;
}

export function createSelectorMap(overrides: Partial<SelectorMap> = {}): SelectorMap {
  const base: SelectorMap = {
    css_selectors: new Map<number, string>(),
    xpath_selectors: new Map<number, string>(),
    coordinates: new Map<number, [number, number]>(),
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (base as unknown as Record<string, unknown>)[k] = v;
  }
  return base;
}

/**
 * 获取元素选择器 —— 对标 SelectorMap.get_selector()
 *
 * 注意 Python 用的是 `a.get(i) or b.get(i)`：空字符串同样会走回退分支，
 * 这里用 `||` 复刻同一语义（而非 `??`）。
 */
export function getSelectorFromMap(map: SelectorMap, index: number, prefer = "css"): string | null {
  if (prefer === "xpath") {
    return map.xpath_selectors.get(index) || (map.css_selectors.get(index) ?? null);
  }
  return map.css_selectors.get(index) || (map.xpath_selectors.get(index) ?? null);
}

/** 获取元素中心坐标 —— 对标 SelectorMap.get_coordinates() */
export function getCoordinatesFromMap(map: SelectorMap, index: number): [number, number] | null {
  return map.coordinates.get(index) ?? null;
}

// ==================== DOM 快照 ====================

/**
 * DOM 快照 —— 对标 DOMSnapshot
 *
 * 包含完整的 DOM 树信息和选择器映射。
 */
export interface DOMSnapshot {
  dom_tree: DOMTree;
  selector_map: SelectorMap;
  /** {width, height} */
  viewport: Record<string, number>;
  /** {x, y} */
  scroll_position: Record<string, number>;
}

export function createDomSnapshot(
  overrides: Partial<DOMSnapshot> & { dom_tree: DOMTree; selector_map: SelectorMap },
): DOMSnapshot {
  const base: DOMSnapshot = {
    dom_tree: overrides.dom_tree,
    selector_map: overrides.selector_map,
    viewport: {},
    scroll_position: {},
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (base as unknown as Record<string, unknown>)[k] = v;
  }
  return base;
}

/** 根据索引获取元素 —— 对标 DOMSnapshot.get_element() */
export function getSnapshotElement(snapshot: DOMSnapshot, index: number): DOMElement | null {
  return getDomElement(snapshot.dom_tree, index);
}

/** 获取元素选择器 —— 对标 DOMSnapshot.get_selector() */
export function getSnapshotSelector(snapshot: DOMSnapshot, index: number): string | null {
  return getSelectorFromMap(snapshot.selector_map, index);
}

/** 获取元素坐标 —— 对标 DOMSnapshot.get_coordinates() */
export function getSnapshotCoordinates(snapshot: DOMSnapshot, index: number): [number, number] | null {
  return getCoordinatesFromMap(snapshot.selector_map, index);
}

// ==================== 辅助函数 ====================

/** 过滤出可交互元素 —— 对标 filter_interactive_elements() */
export function filterInteractiveElements(elements: DOMElement[]): DOMElement[] {
  return elements.filter((el) => el.is_interactive && el.is_visible);
}

/** 过滤出可见元素 —— 对标 filter_visible_elements() */
export function filterVisibleElements(elements: DOMElement[]): DOMElement[] {
  return elements.filter((el) => el.is_visible);
}

/** 根据文本查找元素 —— 对标 find_element_by_text() */
export function findElementByText(
  elements: DOMElement[],
  text: string,
  exact = false,
): DOMElement | null {
  const textLower = text.toLowerCase();
  for (const el of elements) {
    const elText = el.text.toLowerCase();
    if (exact) {
      if (elText === textLower) return el;
    } else {
      if (elText.includes(textLower)) return el;
    }
  }
  return null;
}

/** 根据标签名查找元素 —— 对标 find_elements_by_tag() */
export function findElementsByTag(elements: DOMElement[], tagName: string): DOMElement[] {
  const tagLower = tagName.toLowerCase();
  return elements.filter((el) => el.tag_name.toLowerCase() === tagLower);
}

/** 根据角色查找元素 —— 对标 find_elements_by_role() */
export function findElementsByRole(elements: DOMElement[], role: string): DOMElement[] {
  const roleLower = role.toLowerCase();
  return elements.filter((el) => el.role.toLowerCase() === roleLower);
}

export type { DOMElement, DOMTree, Rect };
