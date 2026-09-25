/**
 * 列表分页（渲染层所有 Table / List 共用）
 *
 * - 前端分页：每页 20 / 50 / 100 / 200，默认 50；每页条数按列表分别记在 localStorage（abb/<列表>/pageSize）。
 * - resetDeps 里任一值变化（筛选、搜索、分组、数据源）回到第 1 页；数据变少时页码夹到最后一页。
 * - 勾选跨页保留靠各表自己的 rowSelection（preserveSelectedRowKeys 或受控 selectedRowKeys），与这里无关。
 *   分页后表头勾选框只勾当前页；要跨页全选，rowSelection.selections 用 `crossPageSelections(...)`。
 *
 * 用法：`const pager = usePagination("home", visible.length, [groupId, search]);`
 *       `<Table pagination={pager.pagination} ... />`；占满面板的表格表体高度再扣 `PAGINATION_HEIGHT`。
 */
import { useEffect, useState, type DependencyList } from "react";
import type { PaginationProps } from "antd";
import { PAGE_SIZES, DEFAULT_PAGE_SIZE, clampPage, pageSizeKey, parsePageSize } from "../lib/ui-prefs.ts";

/** 分页器与表格之间的间距 */
const PAGINATION_GAP = 12;
/** 分页器占用的高度（small 分页器 24px + 间距）：占满面板的表格要从表体高度里扣掉 */
export const PAGINATION_HEIGHT = 24 + PAGINATION_GAP;

function readPageSize(list: string): number {
  try {
    return parsePageSize(localStorage.getItem(pageSizeKey(list)));
  } catch {
    // 禁用 localStorage 时用默认值，界面照常可用
    return DEFAULT_PAGE_SIZE;
  }
}

function writePageSize(list: string, size: number): void {
  try {
    localStorage.setItem(pageSizeKey(list), String(size));
  } catch {
    // 写不进去只是下次不记住
  }
}

export interface Pager {
  /** 直接传给 Table / List 的 pagination */
  pagination: PaginationProps;
}

export function usePagination(list: string, total: number, resetDeps: DependencyList): Pager {
  const [pageSize, setPageSize] = useState<number>(() => readPageSize(list));
  const [page, setPage] = useState(1);
  // 筛选条件 / 数据源变化回到第 1 页
  useEffect(() => setPage(1), resetDeps);

  return {
    pagination: {
      current: clampPage(page, total, pageSize),
      pageSize,
      total,
      size: "small",
      showSizeChanger: true,
      pageSizeOptions: PAGE_SIZES.map(String),
      showTotal: (n, [from, to]) => (n === 0 ? "共 0 条" : `第 ${from}-${to} 条，共 ${n} 条`),
      style: { margin: `${PAGINATION_GAP}px 0 0` },
      onChange: (p, size) => {
        if (size !== pageSize) {
          setPageSize(size);
          writePageSize(list, size);
          setPage(1);
        } else {
          setPage(p);
        }
      },
    },
  };
}

/**
 * 表头勾选下拉的跨页选项：「勾选全部筛选结果」（在已勾选基础上追加当前筛选下所有可选行）与「清空勾选」。
 * filteredKeys 只放可选的行（禁用行不要放进来）。
 */
export function crossPageSelections(
  filteredKeys: readonly string[],
  checked: readonly string[],
  onChange: (next: string[]) => void,
): { key: string; text: string; onSelect: () => void }[] {
  return [
    {
      key: "all-filtered",
      text: `勾选全部筛选结果（${filteredKeys.length}）`,
      onSelect: () => onChange([...new Set([...checked, ...filteredKeys])]),
    },
    { key: "none", text: "清空勾选", onSelect: () => onChange([]) },
  ];
}
