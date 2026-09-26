/**
 * 正在跑的登录引擎登记表 —— 让「停止任务」能立刻掐断**窗口已经关掉**的那种登录。
 *
 * 为什么需要它：CDP 连接一断（窗口被关 / 崩掉），引擎里 `page.evaluate`、`loc.click` 这些
 * await **永远不会 settle**，只能等 `withLimit()` 的封顶超时。而「停止不打断进行中的账号」
 * 是既有语义 —— 于是点了停止之后，界面会一直停在进行中的那个账号上（真机 2026-09-26：
 * 批量登录卡在 19/20，点了停止也没反应，实际是那个账号的窗口早就没了）。
 *
 * 窗口确实已经关掉时，那个账号不可能再有任何进展，立即掐断才是对的；窗口还活着时一律不动，
 * 保持既有语义。
 *
 * 为什么可以用进程内的模块状态：任务坞是全局单任务互斥的（TaskRunner 一次只跑一个任务），
 * 所以任一时刻「正在跑的登录引擎」属于同一个任务，不存在互相干扰。
 */

/** 登记表需要的最小能力（真身是 StagehandGoogleEngine） */
export interface LiveLoginEngine {
  /** 窗口（浏览器进程）是否还活着 */
  isWindowAlive(timeoutMs?: number): Promise<boolean>;
  /** 断开与窗口的连接；进行中的页面调用随即失败，账号得以收尾 */
  stop(closeBrowser?: boolean): Promise<void>;
}

const liveEngines = new Map<string, LiveLoginEngine>();

/**
 * 登记一个正在跑的登录引擎；返回注销函数（调用方放进 finally）。
 * 同一个 browserId 重复登记时以最后一次为准，注销只清掉自己那一次登记。
 */
export function registerLiveEngine(browserId: string, engine: LiveLoginEngine): () => void {
  liveEngines.set(browserId, engine);
  return () => {
    if (liveEngines.get(browserId) === engine) liveEngines.delete(browserId);
  };
}

/** 当前登记在册的窗口 id（诊断 / 测试用） */
export function liveEngineIds(): string[] {
  return [...liveEngines.keys()];
}

/**
 * 逐一探活：窗口已经关掉的，立即断开它的引擎（进行中的登录会马上失败并收尾）。
 * 返回被掐断的窗口 id；窗口还活着的原样留着，不改变「停止不打断进行中账号」的语义。
 */
export async function abortLoginsWithClosedWindow(log: (message: string) => void): Promise<string[]> {
  const aborted: string[] = [];
  for (const [browserId, engine] of [...liveEngines]) {
    let alive: boolean;
    try {
      alive = await engine.isWindowAlive();
    } catch {
      // 探针本身出错（不该发生，isWindowAlive 自己吞异常）：宁可不掐断
      alive = true;
    }
    if (alive) continue;

    log(`窗口 ${browserId} 已关闭，立即结束该账号的登录`);
    aborted.push(browserId);
    try {
      await engine.stop(false);
    } catch {
      /* 断开失败不影响停止流程：进行中的调用仍会被封顶超时收掉 */
    }
  }
  return aborted;
}
