/**
 * 从模板窗口批量创建窗口（首页「根据模板创建窗口」）
 *
 * 说明：界面按钮原本是 TODO 桩，只有「复制窗口」这一个动作实现过；
 * 这里把它补成可用的批量任务。
 *
 * 设计取舍（有意为之）：
 *   - 用 ixBrowser 官方的「复制窗口」接口，而不是自己把模板字段读出来再 profile-create：
 *     服务端自己知道一次复制要带哪些东西；手工映射只会漏字段，而漏掉的字段会**静默**变成默认值，
 *     产出一个「看着像模板、其实不一样」的窗口。我们只决定「名字」和「分组」。
 *   - 命名规则：`{前缀}_{序号}`。序号每创建一个都重新按当前窗口列表算（同前缀最大序号 + 1），
 *     所以名字不会撞车，中断后再跑也能接着编号。
 *   - 前缀为空时用模板窗口的名字（界面上写的就是「可选，默认按模板名命名」）。
 *
 * 纯编排 + 注入依赖，单测完全离线。
 */

export type LogFn = (message: string) => void;

export interface CreatedWindow {
  profile_id: number;
  name: string;
}

export interface CreateWindowsResult {
  total: number;
  success_count: number;
  failed_count: number;
  created: CreatedWindow[];
  failed_names: string[];
}

export interface CreateWindowsDeps {
  /** 复制窗口（真机为 IxBrowserClient.copyProfile；返回新窗口 ID） */
  copy: (templateId: number, fields: { name: string; groupId?: number }) => Promise<number>;
  /** 生成下一个窗口名（真机为 getNextWindowName） */
  nextName: (prefix: string) => Promise<string>;
  shouldStop: () => boolean;
  log: LogFn;
  progress: (current: number) => void;
  /** 逐条目结果（任务历史用）：key 用窗口名，消息里带新窗口 ID 或失败原因 */
  item?: (key: string, status: string, message: string) => void;
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 前缀为空时回落到模板窗口的名字；模板名也为空才用 "Profile" */
export function resolveNamePrefix(namePrefix: string, templateName: string): string {
  const trimmed = namePrefix.trim();
  if (trimmed) return trimmed;
  const fallback = templateName.trim();
  return fallback || "Profile";
}

export async function createWindowsFromTemplate(params: {
  templateId: number;
  count: number;
  namePrefix: string;
  /** null / undefined 表示沿用模板窗口的分组 */
  groupId?: number | null;
  deps: CreateWindowsDeps;
}): Promise<CreateWindowsResult> {
  const { templateId, count, namePrefix, groupId } = params;
  const { copy, nextName, shouldStop, log, progress, item } = params.deps;
  const result: CreateWindowsResult = {
    total: count,
    success_count: 0,
    failed_count: 0,
    created: [],
    failed_names: [],
  };

  const prefix = namePrefix.trim();
  log(`准备按模板窗口 ${templateId} 创建 ${count} 个窗口...`);
  progress(0);

  for (let index = 0; index < count; index++) {
    if (shouldStop()) {
      log(`[用户操作] 任务已停止，剩余 ${count - index} 个窗口未创建`);
      break;
    }

    // 每个窗口都重新取名：列表里已有「前缀_1」时下一个就是「前缀_2」
    let name: string;
    try {
      name = await nextName(prefix);
    } catch (error) {
      const message = errText(error);
      result.failed_count += 1;
      log(`[错误] ${index + 1}/${count} 计算窗口名称失败: ${message}`);
      item?.(prefix || "(自动命名)", "失败", message);
      progress(index + 1);
      continue;
    }

    try {
      const id = await copy(templateId, groupId ? { name, groupId } : { name });
      result.success_count += 1;
      result.created.push({ profile_id: id, name });
      log(`[${index + 1}/${count}] ✓ 已创建窗口 ${id}: ${name}`);
      item?.(name, "成功", `新窗口 ID: ${id}`);
    } catch (error) {
      const message = errText(error);
      result.failed_count += 1;
      result.failed_names.push(name);
      log(`[${index + 1}/${count}] ✗ 创建窗口失败（${name}）: ${message}`);
      item?.(name, "失败", message);
    }
    progress(index + 1);
  }

  log(`创建完成: 成功 ${result.success_count}，失败 ${result.failed_count}`);
  return result;
}
