/**
 * BrowserUse Engine - 提示词管理器（Node 重写）
 * 对标 core/browseruse_engine/agent/prompts/__init__.py
 *
 * 移植说明：
 *   - Python 的 PROMPTS_DIR = Path(__file__).parent 定位同目录下的 md；
 *     Node 侧用 new URL("./prompts/<name>.md", import.meta.url) 定位
 *     desktop/src/browseruse/agent/prompts/ 下的 md（由 Python 侧逐字节复制而来），
 *     并额外支持构造时注入 promptsDir（便于测试），Python 无此参数
 *   - 关键字参数 → 对象形式选项；`language` 保持默认 "en"
 *   - logger.debug/warning → 注入的 LogFn（默认 noopLog）
 *   - FileNotFoundError 分支 → 捕获 readFileSync 的任何异常后回退默认模板
 *   - get_user_prompt 里 Python 用 hasattr 判断 BrowserState/AgentHistory 是否带描述方法；
 *     TS 侧它们是纯数据结构，直接调用 ../types.ts 的 getStateDescription /
 *     getHistoryDescription，段落顺序与标题文本逐字一致
 */

import { readFileSync } from "node:fs";
import { sep } from "node:path";
import { pathToFileURL } from "node:url";

import type { AgentHistory, BrowserState } from "../types.ts";
import { getHistoryDescription, getStateDescription } from "../types.ts";
import { noopLog, type LogFn } from "../page.ts";

/** 提示词目录 —— 对标 PROMPTS_DIR = Path(__file__).parent */
export const PROMPTS_DIR = new URL("./prompts/", import.meta.url);

export interface PromptManagerOptions {
  /** 语言 ("en" 或 "zh") */
  language?: string;
  /** 自定义提示词目录（Python 侧没有，仅用于测试注入） */
  promptsDir?: URL | string;
  log?: LogFn;
}

export interface GetSystemPromptOptions {
  /** 动作描述 (覆盖默认) —— Python 侧接收但未使用，此处照搬 */
  actionDescriptions?: string | null;
  /** 自定义指令 (追加) */
  customInstructions?: string | null;
}

export interface GetUserPromptOptions {
  /** 任务描述 */
  task: string;
  /** 浏览器状态 */
  browserState: BrowserState | null | undefined;
  /** Agent 历史 */
  agentHistory?: AgentHistory | null;
  /** 当前步骤号 */
  stepNumber?: number;
  /** 最大步骤数 */
  maxSteps?: number;
}

/**
 * 提示词管理器
 *
 * 负责加载提示词模板并格式化为 LLM 可用的消息。
 */
export class PromptManager {
  language: string;
  private readonly promptsDir: URL;
  private readonly log: LogFn;
  private _systemPrompt: string | null = null;

  constructor(options: PromptManagerOptions = {}) {
    this.language = options.language ?? "en";
    this.promptsDir = normalizeDir(options.promptsDir);
    this.log = options.log ?? noopLog;
    this._loadTemplates();
  }

  /** 加载提示词模板 */
  private _loadTemplates(): void {
    // 根据语言选择模板文件
    const templateFile =
      this.language === "zh"
        ? new URL("system_prompt_zh.md", this.promptsDir)
        : new URL("system_prompt.md", this.promptsDir);

    try {
      this._systemPrompt = readFileSync(templateFile, "utf-8");
      this.log(`加载提示词模板: ${templateFile.href}`);
    } catch {
      this.log(`提示词模板不存在: ${templateFile.href}，使用默认模板`);
      this._systemPrompt = this._getDefaultPrompt();
    }
  }

  /** 获取默认提示词 —— 与 Python _get_default_prompt() 逐字一致 */
  private _getDefaultPrompt(): string {
    return `You are an AI browser automation agent. Analyze the page state and execute actions to complete the user's task.

Output JSON format:
{
  "thinking": "your reasoning",
  "evaluation_previous_goal": "assessment of previous action",
  "memory": "important info to remember",
  "next_goal": "next step goal",
  "action": [{"action_name": {"param": "value"}}]
}

Available actions: navigate, click, input, scroll, extract, wait, press_key, go_back, done
`;
  }

  /**
   * 获取格式化的系统提示词
   *
   * @returns 格式化后的系统提示词
   */
  getSystemPrompt(options: GetSystemPromptOptions = {}): string {
    let prompt = this._systemPrompt || this._getDefaultPrompt();

    if (options.customInstructions) {
      prompt += `\n\n## Additional Instructions\n\n${options.customInstructions}`;
    }

    return prompt;
  }

  /**
   * 构建用户消息
   *
   * @returns 格式化的用户消息
   */
  getUserPrompt(options: GetUserPromptOptions): string {
    const { task, browserState, agentHistory = null } = options;
    const stepNumber = options.stepNumber ?? 0;
    const maxSteps = options.maxSteps ?? 50;

    const sections: string[] = [];

    // 历史记录
    if (agentHistory) {
      const historyText = getHistoryDescription(agentHistory);
      if (historyText && historyText !== "No previous actions.") {
        sections.push(`<agent_history>\n${historyText}\n</agent_history>`);
      }
    }

    // 浏览器状态
    if (browserState) {
      const stateText = getStateDescription(browserState);
      sections.push(`<browser_state>\n${stateText}\n</browser_state>`);
    }

    // 任务和步骤信息
    sections.push(`<task>\n${task}\n</task>`);
    sections.push(`<step_info>\nStep ${stepNumber + 1} of ${maxSteps}\n</step_info>`);

    return sections.join("\n\n");
  }

  /** 切换语言 */
  setLanguage(language: string): void {
    if (language !== this.language) {
      this.language = language;
      this._loadTemplates();
    }
  }
}

// ==================== 便捷函数 ====================

let _defaultManager: PromptManager | null = null;

/** 获取提示词管理器实例 —— 对标 get_prompt_manager() */
export function getPromptManager(language = "en"): PromptManager {
  if (_defaultManager === null || _defaultManager.language !== language) {
    _defaultManager = new PromptManager({ language });
  }
  return _defaultManager;
}

/** 获取系统提示词 —— 对标模块级 get_system_prompt() */
export function getSystemPrompt(language = "en"): string {
  return getPromptManager(language).getSystemPrompt();
}

/**
 * promptsDir 归一化：字符串一律当作文件系统目录路径（pathToFileURL），
 * URL 直接使用；两者都补上结尾分隔符，以便 new URL(name, base) 相对解析。
 */
function normalizeDir(dir: URL | string | undefined): URL {
  if (dir === undefined) return PROMPTS_DIR;
  if (typeof dir === "string") {
    const suffixed = dir.endsWith("/") || dir.endsWith("\\") ? dir : `${dir}${sep}`;
    return pathToFileURL(suffixed);
  }
  return dir.href.endsWith("/") ? dir : new URL(`${dir.href}/`);
}
