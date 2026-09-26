/**
 * 系统通知的发送策略 —— 纯函数，不依赖 electron，可被 node --test 直接导入
 * （与 navigation.ts / data-root.ts 同一手法）。
 *
 * 策略：应用在前台时**不发**系统通知。任务结束的结果已经在底部任务坞里，
 * 再弹一条系统通知就是同一次操作的第二处提示 —— 真机 2026-09-26 一次「删除账号」
 * 同时出现「结果弹窗 + 右上卡片 + Windows 通知」三处，用户反馈「弹框太多」。
 * 判定放主进程：`isFocused()` 是权威信号。
 */

/** 判前台只需要这两个能力（真实对象是 Electron BrowserWindow） */
export interface FocusableWindow {
  isDestroyed(): boolean;
  isFocused(): boolean;
}

/** 是否有窗口正被用户聚焦（已销毁的窗口不算） */
export function anyWindowFocused(windows: readonly FocusableWindow[]): boolean {
  return windows.some((w) => !w.isDestroyed() && w.isFocused());
}
