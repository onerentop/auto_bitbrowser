/**
 * 后端进程入口 —— 由主进程用 Electron `utilityProcess.fork()` 拉起
 *
 * -Desktop 的 out/main/plugin-host-process.js：本文件只负责收发消息 
 * 业务全部在分发表（dispatch.ts）与各 handler 里。
 *
 * 协议（见 app/shared/ipc.ts）：
 *   主进程 → 本进程：{ type: "request", id, channel, args }
 *   本进程 → 主进程：{ type: "response", id, envelope }
 *                    { type: "ready", pid }     启动完成后发一次
 *
 * 为什么后端要独立进程：批量登录、Stagehand、Playwright 都是长时间运行、
 * 可能崩溃或阻塞事件循环的任务；放在主进程会冻住窗口。这里崩了，
 * 主进程只会把状态标成 crashed，窗口照常可用，并可手动重启。
 */
import { createDispatcher } from "./dispatch.ts";
import { createHostHandlers } from "./handlers/index.ts";
import { DATA_ROOT_ENV, createHostContext } from "./context.ts";
import { ERROR_CODES, errEnvelope } from "../shared/envelope.ts";
import { isHostRequestMessage, type HostOutboundMessage } from "../shared/ipc.ts";
import { registerStagehandConfigSource } from "../../src/engine/stagehand-config.ts";
import { registerCaptchaConfigSource } from "../../src/engine/captcha/config.ts";

/** utilityProcess 里 process.parentPort 的最小形状 */
interface ParentPortLike {
  on(event: "message", listener: (e: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;

if (!parentPort) {
  // 直接用 node 运行本文件时没有 parentPort，给出明确提示而不是静默退出
  process.stderr.write("[abb-host] 必须由 Electron utilityProcess 拉起（缺少 process.parentPort）\n");
  process.exit(1);
}

const port = parentPort;
const send = (message: HostOutboundMessage): void => port.postMessage(message);

const dataRoot = process.env[DATA_ROOT_ENV];
if (!dataRoot) {
  // 数据根目录必须由主进程给出：猜错路径会读写到错误的 accounts.db
  process.stderr.write(`[abb-host] 缺少环境变量 ${DATA_ROOT_ENV}（应由主进程传入）\n`);
  process.exit(1);
}

const ctx = createHostContext({
  dataRoot,
  // 任务日志 / 进度 / 结束事件推给主进程，由主进程按白名单转发给渲染层
  emit: (channel, payload) => {
    try {
      send({ type: "event", channel, payload });
    } catch (error) {
      process.stderr.write(`[abb-host] 事件无法发送（${channel}）: ${String(error)}\n`);
    }
  },
  log: (m) => process.stdout.write(`${m}\n`),
});

const dispatch = createDispatcher(createHostHandlers(ctx));

// Stagehand 引擎在调用方未传 model/key 时回落到这份配置（取自 ConfigManager）
// Stagehand 引擎在调用方未传 model/key 时回落到这份配置（取自 ConfigManager）
registerStagehandConfigSource(() => ctx.config());
// 打码（CapSolver）密钥同样由宿主注册：engine 层不认识 ConfigManager，
// 未注册时 resolveCaptchaConfig() 返回 null —— 登录遇到验证码就维持旧的 captcha_required。
registerCaptchaConfigSource(() => ctx.config());

port.on("message", (event) => {
  const message = event.data;
  if (!isHostRequestMessage(message)) {
    // 协议外的消息直接丢弃：主进程是唯一发送方，出现这种情况说明版本不匹配
    process.stderr.write(`[abb-host] 忽略无法识别的消息: ${JSON.stringify(message)}\n`);
    return;
  }
  void dispatch(message.channel, message.args).then((envelope) => {
    try {
      send({ type: "response", id: message.id, envelope });
    } catch (error) {
      // handler 返回了不可结构化克隆的数据（带函数、类实例等）时 postMessage 会抛 DataCloneError。
      // 必须回一个错误信封，否则主进程要等满 30s 才超时
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[abb-host] 响应无法序列化（${message.channel}）: ${reason}\n`);
      send({
        type: "response",
        id: message.id,
        envelope: errEnvelope(ERROR_CODES.INTERNAL, `后端返回值无法跨进程传递: ${reason}`),
      });
    }
  });
});

// 未捕获异常只记日志，不让单个任务的疏漏拖垮整个后端进程
process.on("uncaughtException", (error) => {
  process.stderr.write(`[abb-host] uncaughtException: ${error.stack ?? error.message}\n`);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[abb-host] unhandledRejection: ${String(reason)}\n`);
});

send({ type: "ready", pid: process.pid });
