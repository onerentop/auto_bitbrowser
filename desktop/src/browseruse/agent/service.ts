/**
 * BrowserUse Engine - Agent 服务核心（Node 重写）
 * 对标 core/browseruse_engine/agent/service.py
 *
 * 移植说明：
 *   - 构造参数改为对象形式（engine.ts 依赖此签名）；Python 里 dom_service /
 *     action_executor 缺省时会 new 一个，TS 侧改为**必传**（这两个类的构造签名
 *     由并行移植的 dom/tools 子层决定，不在本层猜测）；prompt_manager 仍可缺省
 *   - time.time()（秒）→ Date.now()（毫秒）；duration_ms 直接做差，不再 *1000
 *   - logger.* → 注入的 LogFn（默认 noopLog）
 *   - Python 的 for/else（循环未 break 才执行）→ completedWithoutBreak 标志
 *   - self.page.url 属性 → Playwright JS 的 page.url() 方法
 *   - llm.ainvoke(response_format=AgentOutput) → ainvoke(msgs, AGENT_OUTPUT_FORMAT)
 *   - AgentOutput(**data) → parseAgentOutput(JSON.parse(content))
 *   - str(e) → formatError(e)（取 Error.message，与 Python 的 str(e) 文案对齐）
 *   - Python 的 `from ..tools.registry import ActionRegistry` 未被使用，未移植
 *   - 三条 LLM 输出解析分支、各条错误文案、循环终止条件均逐字照搬，顺序不变
 */

import { MessageManager } from "./message-manager.ts";
import { PromptManager } from "./prompts.ts";
import {
  AgentStatusValues,
  createAgentState,
  createStepResult,
  getStepDoneMessage,
  isAgentRunning,
  isStepDone,
  type AgentState,
  type StepResult,
} from "./views.ts";
import type { DomService } from "../dom/service.ts";
import type { ActionExecutor } from "../tools/executor.ts";
import type { BaseChatModel } from "../llm/base.ts";
import { AGENT_OUTPUT_FORMAT } from "../llm/base.ts";
import {
  createAgentHistory,
  createAgentStepRecord,
  getActionParams,
  getActionType,
  parseAgentOutput,
  type AgentOutput,
} from "../types.ts";
import { createAgentResult, createAgentStep, type ActionResult, type AgentResult } from "../protocol.ts";
import { noopLog, type BrowserPageLike, type LogFn } from "../page.ts";

export interface AgentServiceOptions {
  /** LLM 适配器 */
  llm: BaseChatModel;
  /** 浏览器页面对象 */
  page: BrowserPageLike;
  /** DOM 服务 */
  domService: DomService;
  /** 动作执行器 */
  actionExecutor: ActionExecutor;
  /** 提示词管理器（不传则按 language 自动创建，对齐 Python） */
  promptManager?: PromptManager;
  /** 是否使用视觉 (截图) */
  useVision?: boolean;
  /** 每步最大动作数 */
  maxActionsPerStep?: number;
  /** 语言 */
  language?: string;
  log?: LogFn;
}

export interface AgentRunOptions {
  /** 最大步数 */
  maxSteps?: number;
  /** 步骤回调函数（Python 是 async，TS 允许同步或返回 Promise，均会 await） */
  onStep?: (step: Record<string, unknown>) => void | Promise<void>;
  /** 自定义指令 */
  customInstructions?: string;
}

/**
 * Agent 服务
 *
 * 核心的 Agent 循环调度器，负责：
 * 1. 获取浏览器状态
 * 2. 构建 LLM 提示词
 * 3. 调用 LLM 获取决策
 * 4. 执行动作序列
 * 5. 记录历史和状态
 */
export class AgentService {
  readonly llm: BaseChatModel;
  readonly page: BrowserPageLike;
  readonly useVision: boolean;
  readonly maxActionsPerStep: number;
  readonly language: string;

  readonly domService: DomService;
  readonly actionExecutor: ActionExecutor;
  readonly promptManager: PromptManager;
  readonly messageManager: MessageManager;

  private readonly log: LogFn;
  private _state: AgentState;
  private _stopRequested = false;

  constructor(options: AgentServiceOptions) {
    this.llm = options.llm;
    this.page = options.page;
    this.useVision = options.useVision ?? true;
    this.maxActionsPerStep = options.maxActionsPerStep ?? 3;
    this.language = options.language ?? "en";
    this.log = options.log ?? noopLog;

    // 初始化组件
    this.domService = options.domService;
    this.actionExecutor = options.actionExecutor;
    this.promptManager =
      options.promptManager ?? new PromptManager({ language: this.language, log: this.log });
    this.messageManager = new MessageManager({ log: this.log });

    // 状态
    this._state = createAgentState();
  }

  /**
   * 执行 Agent 任务
   *
   * @param task 任务描述
   * @param options.maxSteps 最大步数（默认 50）
   * @param options.onStep 步骤回调函数
   * @param options.customInstructions 自定义指令
   */
  async run(task: string, options: AgentRunOptions = {}): Promise<AgentResult> {
    const maxSteps = options.maxSteps ?? 50;
    const onStep = options.onStep;
    const customInstructions = options.customInstructions;

    const startTime = Date.now();
    this._stopRequested = false;

    // 初始化状态
    this._state = createAgentState({
      status: AgentStatusValues.RUNNING,
      task,
      max_steps: maxSteps,
      history: createAgentHistory({ task, start_time: startTime }),
    });

    // 初始化消息
    const systemPrompt = this.promptManager.getSystemPrompt({
      customInstructions: customInstructions ?? null,
    });
    this.messageManager.clear();
    this.messageManager.addSystemMessage(systemPrompt);

    const steps: StepResult[] = [];
    let extractedContent: string | null = null;

    try {
      // 对应 Python 的 for/else：循环跑满（未 break）才走「达到最大步数」分支
      let completedWithoutBreak = true;

      for (let stepNum = 0; stepNum < maxSteps; stepNum++) {
        if (this._stopRequested) {
          this.log("收到停止请求，终止 Agent");
          this._state.status = AgentStatusValues.STOPPED;
          completedWithoutBreak = false;
          break;
        }

        this._state.current_step = stepNum;

        // 执行单步
        const stepResult = await this._executeStep(stepNum, task, maxSteps);
        steps.push(stepResult);

        // 更新历史
        if (this._state.history) {
          const record = createAgentStepRecord({
            step_number: stepNum,
            agent_output: stepResult.agent_output,
            action_results: stepResult.action_results.map((r) => ({
              success: r.success,
              message: r.message,
              error: r.error,
            })),
            browser_state: stepResult.browser_state_after,
            error: stepResult.error,
            timestamp: Date.now(),
          });
          this._state.history.steps.push(record);
        }

        // 回调
        if (onStep) {
          await onStep(stepResult as unknown as Record<string, unknown>);
        }

        // 检查是否完成
        if (isStepDone(stepResult)) {
          extractedContent = getStepDoneMessage(stepResult);
          this._state.status = AgentStatusValues.COMPLETED;
          this.log(`任务完成: ${extractedContent}`);
          completedWithoutBreak = false;
          break;
        }

        // 检查错误
        if (stepResult.error) {
          this.log(`步骤 ${stepNum} 出错: ${stepResult.error}`);
          // 继续执行，让 Agent 尝试恢复
        }

        // 动作之间等待
        await sleep(500);
      }

      if (completedWithoutBreak) {
        // 达到最大步数
        this.log(`达到最大步数 ${maxSteps}`);
        this._state.status = AgentStatusValues.FAILED;
        this._state.error = "达到最大步数限制";
      }
    } catch (e) {
      this.log(`Agent 执行异常: ${formatError(e)}`);
      this._state.status = AgentStatusValues.FAILED;
      this._state.error = formatError(e);
    }

    // 计算统计
    const durationMs = Date.now() - startTime;

    // 获取最终 URL
    let finalUrl = "";
    try {
      finalUrl = this.page.url();
    } catch {
      // pass
    }
    void finalUrl; // Python 侧算出 final_url 后同样没有放进 AgentResult，保持一致

    return createAgentResult({
      success: this._state.status === AgentStatusValues.COMPLETED,
      message: extractedContent || "",
      error: this._state.error,
      extracted_content: extractedContent,
      steps: steps.map((s) => {
        const firstAction = s.agent_output && s.agent_output.action.length > 0 ? s.agent_output.action[0] : null;
        return createAgentStep({
          step_number: s.step_number,
          thinking: s.agent_output ? s.agent_output.thinking : "",
          action_name: firstAction ? (getActionType(firstAction) ?? "") : "",
          action_params: firstAction ? getActionParams(firstAction) : {},
          result: s.action_results.length > 0 ? (s.action_results[0] as ActionResult) : null,
          browser_url: s.browser_state_after ? s.browser_state_after.url : "",
          timestamp: Date.now(),
        });
      }),
      total_steps: steps.length,
      duration_ms: durationMs,
    });
  }

  /** 执行单个步骤 */
  private async _executeStep(stepNum: number, task: string, maxSteps: number): Promise<StepResult> {
    const stepStart = Date.now();

    // 1. 获取浏览器状态
    const browserState = await this.domService.getBrowserState({
      includeScreenshot: this.useVision,
    });
    this._state.browser_state = browserState;

    // 2. 构建用户消息
    const userPrompt = this.promptManager.getUserPrompt({
      task,
      browserState,
      agentHistory: this._state.history,
      stepNumber: stepNum,
      maxSteps,
    });

    // 添加消息
    if (this.useVision && browserState.screenshot_base64) {
      this.messageManager.addUserMessage(userPrompt, browserState.screenshot_base64);
    } else {
      this.messageManager.addUserMessage(userPrompt);
    }

    // 3. 调用 LLM
    let agentOutput: AgentOutput | null;
    try {
      // llm/base.ts 的 ainvoke 是位置参数（messages, responseFormat, temperature, maxTokens）
      const response = await this.llm.ainvoke(this.messageManager.getMessages(), AGENT_OUTPUT_FORMAT);

      // ChatCompletion.parsed 是 unknown（Python 侧是 Optional[Any]），这里断言为 AgentOutput
      agentOutput = (response.parsed ?? null) as AgentOutput | null;
      if (!agentOutput) {
        // 尝试从内容解析
        try {
          let content = response.content;
          if (content.includes("```json")) {
            content = content.split("```json")[1]!.split("```")[0]!;
          } else if (content.includes("```")) {
            content = content.split("```")[1]!.split("```")[0]!;
          }
          const data: unknown = JSON.parse(content);
          agentOutput = parseAgentOutput(data);
        } catch (e) {
          this.log(`解析 LLM 输出失败: ${formatError(e)}`);
          return createStepResult({
            step_number: stepNum,
            error: `解析 LLM 输出失败: ${formatError(e)}`,
            browser_state_before: browserState,
            duration_ms: Date.now() - stepStart,
          });
        }
      }

      // 最终检查 agent_output 是否有效
      if (!agentOutput) {
        this.log("无法获取有效的 Agent 输出");
        return createStepResult({
          step_number: stepNum,
          error: "无法获取有效的 Agent 输出",
          browser_state_before: browserState,
          duration_ms: Date.now() - stepStart,
        });
      }

      // 添加助手消息
      this.messageManager.addAssistantMessage(response.content);
    } catch (e) {
      this.log(`LLM 调用失败: ${formatError(e)}`);
      return createStepResult({
        step_number: stepNum,
        error: `LLM 调用失败: ${formatError(e)}`,
        browser_state_before: browserState,
        duration_ms: Date.now() - stepStart,
      });
    }

    // 4. 执行动作
    const actions = agentOutput.action.slice(0, this.maxActionsPerStep);
    const actionResults: ActionResult[] = [];

    for (const action of actions) {
      const result = await this.actionExecutor.execute(action);
      actionResults.push(result);

      // 如果是 done 动作，停止执行
      if (action.done !== undefined && action.done !== null) {
        break;
      }
    }

    // 5. 获取执行后的状态
    const browserStateAfter = await this.domService.getBrowserState({
      includeScreenshot: false,
    });

    this._state.last_output = agentOutput;
    this._state.last_results = actionResults;

    const durationMs = Date.now() - stepStart;
    this.log(
      `Step ${stepNum}: ${agentOutput.next_goal} - ` + `${actions.length} actions, ${durationMs.toFixed(0)}ms`,
    );

    return createStepResult({
      step_number: stepNum,
      agent_output: agentOutput,
      action_results: actionResults,
      browser_state_before: browserState,
      browser_state_after: browserStateAfter,
      duration_ms: durationMs,
    });
  }

  /** 请求停止 Agent */
  stop(): void {
    this._stopRequested = true;
  }

  /** 获取当前状态 */
  get state(): AgentState {
    return this._state;
  }

  /** 是否正在运行 */
  get isRunning(): boolean {
    return isAgentRunning(this._state);
  }
}

/** 对标 asyncio.sleep */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 对标 Python 的 str(e)：Error 取 message，其余按字符串化 */
function formatError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
