/**
 * 踢出设备操作（Node 重写）
 * 对标 core/stagehand_engine/operations/kick_devices.py
 *
 * 提示词逐字照搬 Python 版——它们是调试出来的资产，改一个字都可能影响 LLM 行为。
 */
import { z } from "zod";
import type { StagehandGoogleEngine } from "../stagehand-engine.ts";
import { GoogleURLs, Timeouts } from "../constants.ts";
import { createKickDevicesResult, type KickDevicesResult } from "../types.ts";

/**
 * 当前设备的标识关键词（多语言）。
 * keep_current=true 时命中这些词的设备会被跳过。
 */
export const CURRENT_DEVICE_KEYWORDS = [
  // 中文
  "(当前会话)", "当前会话", "当前设备", "此设备",
  // 英文
  "your current session", "current session", "this device",
  // 日文
  "現在のセッション", "このデバイス",
  // 韩文
  "현재 세션", "이 기기",
  // 越南语
  "phiên hiện tại", "thiết bị này",
];

const DeviceListSchema = z.object({
  devices: z.array(
    z.object({
      device_name: z.string().optional(),
      is_current: z.boolean().optional(),
    }),
  ),
});

export class KickDevicesOperation {
  private readonly engine: StagehandGoogleEngine;

  constructor(engine: StagehandGoogleEngine) {
    this.engine = engine;
  }

  async execute(options: { keepCurrent?: boolean } = {}): Promise<KickDevicesResult> {
    const keepCurrent = options.keepCurrent ?? true;
    const start = Date.now();
    const kicked: string[] = [];
    const failed: string[] = [];

    const done = (r: Partial<KickDevicesResult> & { success: boolean; message: string }): KickDevicesResult =>
      createKickDevicesResult({
        kicked_devices: kicked,
        failed_devices: failed,
        duration_ms: Date.now() - start,
        ...r,
      });

    try {
      // 1. 导航到设备管理页
      const nav = await this.engine.navigate(GoogleURLs.DEVICES, {
        timeoutMs: Timeouts.NAVIGATION,
      });
      if (!nav.success) {
        return done({ success: false, message: "导航到设备页面失败", error: nav.error });
      }

      await this.engine.wait(Timeouts.AFTER_NAVIGATION);

      // 2. 检查登录态
      const url = await this.engine.getCurrentUrl();
      if (url.includes("accounts.google.com") && url.includes("signin")) {
        return done({ success: false, message: "需要先登录账号", error: "未登录" });
      }

      // 3. 取设备列表
      const devices = await this.getDeviceList();
      if (devices.length === 0) {
        return done({ success: true, message: "未找到其他设备" });
      }

      // 4. 逐个踢出非当前设备
      for (const name of devices) {
        if (!name) continue;

        if (keepCurrent) {
          const lower = name.toLowerCase();
          const isCurrent = CURRENT_DEVICE_KEYWORDS.some((k) => lower.includes(k.toLowerCase()));
          if (isCurrent) continue;
        }

        const ok = await this.kickSingleDevice(name);
        if (ok) kicked.push(name);
        else failed.push(name);

        await this.engine.wait(1000);
      }

      let message: string;
      if (kicked.length > 0) {
        message = `成功踢出 ${kicked.length} 个设备`;
        if (failed.length > 0) message += `，${failed.length} 个失败`;
      } else {
        message = "没有需要踢出的设备";
      }

      return done({
        success: true,
        message,
        devices_found: devices.length,
        devices_kicked: kicked.length,
        devices_failed: failed.length,
      });
    } catch (err) {
      return done({
        success: false,
        message: "踢出设备操作异常",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 先 observe，失败时回退到 extract */
  private async getDeviceList(): Promise<string[]> {
    try {
      const observed = await this.engine.observe(
        "找到页面上所有显示的设备卡片或设备条目，包括设备名称",
      );

      if (!observed.success) {
        const extracted = await this.engine.extract<{ devices?: { device_name?: string }[] }>(
          `
                    提取页面上所有已登录设备的信息:
                    1. 每个设备的名称
                    2. 是否是当前设备（标记为"您的当前会话"或"Your current session"）
                    3. 设备总数
                    `,
          DeviceListSchema,
        );
        if (extracted.success && extracted.data) {
          return (extracted.data.devices ?? [])
            .map((d) => d.device_name ?? "")
            .filter((n) => n.length > 0);
        }
      }

      // 从 observe 结果里挑出描述含 device 的条目
      const actions = observed.data ?? [];
      const names: string[] = [];
      for (const action of actions) {
        if (action && typeof action === "object") {
          const desc = (action as { description?: string }).description ?? "";
          if (desc && desc.toLowerCase().includes("device")) names.push(desc);
        }
      }
      return names;
    } catch {
      return [];
    }
  }

  /** 点击设备 → 退出登录 → 确认；每步都有备选指令 */
  private async kickSingleDevice(deviceName: string): Promise<boolean> {
    try {
      let click = await this.engine.act(`点击名为 '${deviceName}' 的设备卡片或设备条目`);
      if (!click.success) {
        click = await this.engine.act("点击第一个非当前会话的设备");
      }
      await this.engine.wait(Timeouts.AFTER_CLICK);

      let signout = await this.engine.act("点击'退出登录'或'Sign out'按钮");
      if (!signout.success) {
        signout = await this.engine.act("点击'移除'或'Remove'或'登出'按钮");
      }
      await this.engine.wait(Timeouts.AFTER_CLICK);

      await this.engine.act("如果有确认对话框，点击确认或确定按钮");
      await this.engine.wait(Timeouts.AFTER_CLICK);

      return true;
    } catch {
      return false;
    }
  }
}