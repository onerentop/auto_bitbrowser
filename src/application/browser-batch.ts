/**
 * 首页「批量打开 / 删除窗口」的用例：逐个执行，每个窗口一行日志 + 一条逐条目结果（任务历史用），
 * 更新进度，支持中途停止。具体对窗口做什么由调用方传入 op（打开 / 删除）。
 */
import type { HomeBatchResult } from "../../app/shared/channels/home.ts";

/** 后台任务提供给用例的最小接口（app/host 的 TaskApi 天然满足） */
export interface BatchTaskApi {
  log(message: string): void;
  progress(current: number, total: number): void;
  item(key: string, status: string, message: string): void;
  shouldStop(): boolean;
}

/** 对单个窗口的操作；log 是本条目内的底层日志（失败原因取最后一条） */
export type BrowserOp = (id: number, log: (message: string) => void) => Promise<boolean>;

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runBrowserBatch(
  api: BatchTaskApi,
  ids: readonly number[],
  verb: string,
  op: BrowserOp,
): Promise<HomeBatchResult> {
  const total = ids.length;
  const failed: number[] = [];
  let success = 0;
  let done = 0;
  api.log(`准备${verb} ${total} 个窗口...`);
  api.progress(0, total);
  for (const id of ids) {
    if (api.shouldStop()) {
      api.log(`[用户操作] 任务已停止，剩余 ${total - done} 个窗口未处理`);
      break;
    }
    let ok = false;
    let failure = "";
    // 本条目内最后一条底层日志：失败时的原因（「窗口不存在」这类）只在底层日志里，
    // 逐条目消息带上它，任务历史才能回答「为什么失败」
    const log = (message: string): void => {
      failure = message;
      api.log(message);
    };
    try {
      ok = await op(id, log);
    } catch (error) {
      failure = errText(error);
      api.log(`[错误] 窗口 ${id} ${verb}异常: ${failure}`);
    }
    done += 1;
    if (ok) {
      success += 1;
      api.log(`[${done}/${total}] ✓ 窗口 ${id} ${verb}成功`);
      api.item(String(id), "成功", "");
    } else {
      failed.push(id);
      api.log(`[${done}/${total}] ✗ 窗口 ${id} ${verb}失败`);
      // 逐条目结果：任务历史（总数 / 成功 / 失败）靠它统计。只打日志的话，
      // 真机上任务虽然成功，历史里却全是 0（2026-09-24 复现）。
      api.item(String(id), "失败", failure || `窗口 ${id} ${verb}失败`);
    }
    api.progress(done, total);
  }
  api.log(`${verb}完成: 成功 ${success}，失败 ${failed.length}`);
  return { total, success_count: success, failed_count: failed.length, failed_ids: failed };
}
