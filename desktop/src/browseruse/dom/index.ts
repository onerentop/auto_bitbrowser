/**
 * BrowserUse Engine - DOM 模块（Node 重写）
 * 对标 core/browseruse_engine/dom/__init__.py
 *
 * 提供 DOM 提取和序列化功能。
 *
 * 移植差异：
 *   - Python 的 __all__ 只导出类与辅助函数；TS 侧额外导出各数据结构的
 *     createXxx() 工厂和接口类型（dataclass 拆成"接口 + 工厂"后必须一起给出）
 *   - DOMService → DomService，serialize_dom → serializeDom（命名风格转换）
 */

// 服务
export {
  DomService,
  EXTRACT_ELEMENTS_JS,
  type DomServiceOptions,
  type RawExtractedElement,
  type RawExtractResult,
} from "./service.ts";

// 序列化
export { DOMSerializer, serializeDom, type DOMSerializerOptions } from "./serializer.ts";

// 视图模型 + 辅助函数
export {
  createDomSnapshot,
  createEnhancedDomElement,
  createSelectorMap,
  enhancedToSimple,
  filterInteractiveElements,
  filterVisibleElements,
  findElementByText,
  findElementsByRole,
  findElementsByTag,
  getCoordinatesFromMap,
  getSelectorFromMap,
  getSnapshotCoordinates,
  getSnapshotElement,
  getSnapshotSelector,
  type DOMSnapshot,
  type EnhancedDOMElement,
  type SelectorMap,
} from "./views.ts";
