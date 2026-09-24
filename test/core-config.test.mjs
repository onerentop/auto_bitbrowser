/**
 * core/config-manager.ts 单测（全离线）
 *
 * 覆盖：加解密 roundtrip / ENC: 前缀判定 / 非法密文原样返回 /
 *       点号路径 get·set / mergeConfig 合并规则 / 敏感字段落盘为 ENC:
 *
 * 硬性约束：全部使用注入的临时 configFile（node:os.tmpdir），
 * 绝不触碰仓库根的真实 config.json。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ConfigManager,
  DEFAULT_CONFIG,
  OBFUSCATION_KEY,
  SENSITIVE_CONFIG_PATHS,
  createDefaultConfig,
  decryptSensitive,
  encryptSensitive,
} from "../src/core/config-manager.ts";

// ==================== 工具 ====================

/** 每个用例一个独立临时目录 + 独立 config.json，互不污染 */
function withConfig(fn, initialJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-"));
  const file = path.join(dir, "config.json");
  if (initialJson !== undefined) {
    fs.writeFileSync(file, JSON.stringify(initialJson, null, 2), "utf-8");
  }
  const logs = [];
  const cm = new ConfigManager({ configFile: file, log: (m) => logs.push(m) });
  try {
    return fn({ cm, file, logs, dir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 直接读回落盘后的 JSON */
function readRaw(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

// ==================== 加解密 ====================

test("encryptSensitive/decryptSensitive: ASCII / 中文 / emoji 的 roundtrip", () => {
  for (const plain of ["abc123", "sk-proj-AbCdEf_0123456789", "中文密码·测试", "key🔑emoji😀"]) {
    const enc = encryptSensitive(plain);
    assert.ok(enc.startsWith("ENC:"), `应带 ENC: 前缀: ${enc}`);
    assert.notEqual(enc, plain);
    assert.equal(decryptSensitive(enc), plain);
  }
});

test("encryptSensitive: 空串原样返回空串（不加前缀）", () => {
  assert.equal(encryptSensitive(""), "");
});

test("decryptSensitive: 无 ENC: 前缀的值原样返回", () => {
  assert.equal(decryptSensitive("plaintext"), "plaintext");
  assert.equal(decryptSensitive(""), "");
  assert.equal(decryptSensitive("enc:lowercase"), "enc:lowercase");
});

test("decryptSensitive: 非法密文（base64 长度不合法）返回原值", () => {
  assert.equal(decryptSensitive("ENC:abc"), "ENC:abc");
});

test("decryptSensitive: 非法密文（非 UTF-8 字节）返回原值", () => {
  const bad = `ENC:${Buffer.from([0xff, 0xfe, 0xfd]).toString("base64")}`;
  assert.equal(decryptSensitive(bad), bad);
});

test("decryptSensitive: 二次解密对已解密的明文是幂等的", () => {
  const enc = encryptSensitive("token-123");
  assert.equal(decryptSensitive(decryptSensitive(enc)), "token-123");
});

test("OBFUSCATION_KEY 与 Python 逐字一致", () => {
  assert.equal(OBFUSCATION_KEY, "ixBrowser_AutoManager_2024");
});

// ==================== 敏感路径判定 ====================

test("isSensitiveKeyPath: 固定清单命中 + providers.*.api_key 通配 + 不命中", () => {
  for (const p of SENSITIVE_CONFIG_PATHS) {
    assert.equal(ConfigManager.isSensitiveKeyPath(p), true, p);
  }
  assert.equal(ConfigManager.isSensitiveKeyPath("ai_agent.providers.gemini.api_key"), true);
  assert.equal(ConfigManager.isSensitiveKeyPath("ai_agent.providers.anything.api_key"), true);
  assert.equal(ConfigManager.isSensitiveKeyPath("ai_agent.providers.gemini.model"), false);
  assert.equal(ConfigManager.isSensitiveKeyPath("timeouts.page_load"), false);
  assert.deepEqual([...SENSITIVE_CONFIG_PATHS], [
    "gmail_imap_password",
    "sub2api.password",
    "sub2api.admin_token",
    "sms_bus.token",
    "ai_agent.api_key",
  ]);
});

// ==================== mergeConfig ====================

test("mergeConfig: 保留用户已有值，补齐默认字段（递归）", () => {
  const defaults = { a: 1, b: { c: 2, d: 3, nested: { x: 1 } }, keepMe: "def" };
  const current = { b: { c: 99, nested: { y: 2 } }, extra: true };
  const merged = /** @type {Record<string, any>} */ (ConfigManager.mergeConfig(defaults, current));

  assert.equal(merged.a, 1, "默认字段被补上");
  assert.equal(merged.keepMe, "def");
  assert.equal(merged.b.c, 99, "用户值优先");
  assert.equal(merged.b.d, 3, "嵌套的默认字段被补上");
  assert.deepEqual(merged.b.nested, { x: 1, y: 2 });
  assert.equal(merged.extra, true, "用户独有字段保留");
});

test("mergeConfig: 标量覆盖对象、对象覆盖标量都按用户值走", () => {
  assert.deepEqual(ConfigManager.mergeConfig({ a: { x: 1 } }, { a: 5 }), { a: 5 });
  assert.deepEqual(ConfigManager.mergeConfig({ a: 5 }, { a: { x: 1 } }), { a: { x: 1 } });
  // 数组不是 dict，直接整体替换
  assert.deepEqual(ConfigManager.mergeConfig({ a: [1, 2] }, { a: [3] }), { a: [3] });
});

test("createDefaultConfig: 深拷贝，改动不影响 DEFAULT_CONFIG", () => {
  const c = /** @type {Record<string, any>} */ (createDefaultConfig());
  c.timeouts.page_load = 999;
  assert.equal(/** @type {Record<string, any>} */ (DEFAULT_CONFIG.timeouts).page_load, 30);
  assert.equal(/** @type {Record<string, any>} */ (createDefaultConfig().timeouts).page_load, 30);
});

// ==================== load / save ====================

test("load: 配置文件不存在时写出默认配置", () => {
  withConfig(({ cm, file }) => {
    assert.equal(fs.existsSync(file), false);
    const cfg = cm.load();
    assert.equal(cfg.default_thread_count, 3);
    assert.ok(fs.existsSync(file), "默认配置应被落盘");
    assert.equal(readRaw(file).timeouts.page_load, 30);
  });
});

test("load: 已有配置与默认配置合并，用户值优先", () => {
  withConfig(
    ({ cm }) => {
      assert.equal(cm.get("default_thread_count"), 9);
      assert.equal(cm.get("timeouts.page_load"), 99);
      assert.equal(cm.get("timeouts.status_check"), 20, "缺失字段回落默认值");
      assert.equal(cm.get("my_custom_key"), "keep", "用户独有字段保留");
    },
    { default_thread_count: 9, timeouts: { page_load: 99 }, my_custom_key: "keep" },
  );
});

test("load: 配置文件是坏 JSON 时回退默认配置并重写文件", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-"));
  const file = path.join(dir, "config.json");
  try {
    fs.writeFileSync(file, "{ 这不是 JSON", "utf-8");
    const logs = [];
    const cm = new ConfigManager({ configFile: file, log: (m) => logs.push(m) });
    const cfg = cm.load();
    assert.equal(cfg.default_thread_count, 3);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /\[ConfigManager\] 加载配置失败/);
    assert.equal(readRaw(file).default_thread_count, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reload: 丢弃内存状态重新读盘", () => {
  withConfig(
    ({ cm, file }) => {
      assert.equal(cm.get("default_thread_count"), 1);
      fs.writeFileSync(file, JSON.stringify({ default_thread_count: 7 }), "utf-8");
      assert.equal(cm.get("default_thread_count"), 1, "reload 前仍是内存里的旧值");
      cm.reload();
      assert.equal(cm.get("default_thread_count"), 7);
    },
    { default_thread_count: 1 },
  );
});

// ==================== 点号路径 get / set ====================

test("get: 嵌套读取、缺键返回默认值、中间层非对象也返回默认值", () => {
  withConfig(({ cm }) => {
    assert.equal(cm.get("timeouts.page_load"), 30);
    assert.equal(cm.get("delays.after_save"), 18);
    assert.equal(cm.get("nope"), null, "默认默认值是 null");
    assert.equal(cm.get("nope.deep.deeper", "fallback"), "fallback");
    assert.equal(cm.get("default_thread_count.x", "fallback"), "fallback");
    assert.equal(cm.get("ai_agent.providers.gemini.model"), "gemini-2.5-flash");
  });
});

test("set: 点号路径写入并自动创建缺失的中间层，随后落盘", () => {
  withConfig(({ cm, file }) => {
    cm.set("timeouts.page_load", 45);
    cm.set("brand_new.level1.level2", "深层值");

    assert.equal(cm.get("timeouts.page_load"), 45);
    assert.equal(cm.get("brand_new.level1.level2"), "深层值");

    const raw = readRaw(file);
    assert.equal(raw.timeouts.page_load, 45);
    assert.equal(raw.brand_new.level1.level2, "深层值");
  });
});

test("set: 中间节点是标量时抛 TypeError（对齐 Python 的 TypeError）", () => {
  withConfig(({ cm }) => {
    cm.load();
    assert.throws(() => cm.set("default_thread_count.sub", 1), TypeError);
  });
});

// ==================== 敏感字段落盘 ====================

test("set: 敏感字段落盘为 ENC:，get 读回明文", () => {
  withConfig(({ cm, file }) => {
    cm.set("sub2api.password", "p@ssw0rd");

    const raw = readRaw(file);
    assert.ok(
      String(raw.sub2api.password).startsWith("ENC:"),
      `落盘应为密文，实际: ${raw.sub2api.password}`,
    );
    assert.notEqual(raw.sub2api.password, "p@ssw0rd");
    assert.equal(cm.get("sub2api.password"), "p@ssw0rd", "get 自动解密");
  });
});

test("set: 非敏感字段落盘保持明文", () => {
  withConfig(({ cm, file }) => {
    cm.set("sub2api.username", "alice");
    assert.equal(readRaw(file).sub2api.username, "alice");
  });
});

test("历史明文敏感字段在 load 时自动迁移为密文并记日志", () => {
  withConfig(
    ({ cm, file, logs }) => {
      cm.load();
      const raw = readRaw(file);
      assert.ok(String(raw.sms_bus.token).startsWith("ENC:"));
      assert.equal(cm.get("sms_bus.token"), "legacy-plain-token");
      assert.ok(logs.some((m) => m.includes("已迁移明文敏感字段")));
    },
    { sms_bus: { token: "legacy-plain-token" } },
  );
});

test("敏感路径 sms_bus.token 经 set / get 往返，落盘为密文", () => {
  withConfig(({ cm, file }) => {
    cm.set("sms_bus.token", "sms-token-xyz");
    assert.equal(cm.get("sms_bus.token"), "sms-token-xyz");
    assert.ok(String(readRaw(file).sms_bus.token).startsWith("ENC:"));
  });
});

test("setAiProviderApiKey / getAiProviderApiKey 往返，落盘为密文", () => {
  withConfig(({ cm, file }) => {
    cm.setAiProviderApiKey("gemini", "AIza-secret-key");
    assert.equal(cm.getAiProviderApiKey("gemini"), "AIza-secret-key");
    assert.ok(String(readRaw(file).ai_agent.providers.gemini.api_key).startsWith("ENC:"));
    // 不传 provider 时走默认提供商（gemini）
    assert.equal(cm.getAiProviderApiKey(), "AIza-secret-key");
  });
});

test("getAiProviderConfig: 返回的 api_key 已解密，其余字段照旧", () => {
  withConfig(({ cm }) => {
    cm.setAiProviderApiKey("anthropic", "sk-ant-123");
    const cfg = cm.getAiProviderConfig("anthropic");
    assert.equal(cfg.api_key, "sk-ant-123");
    assert.equal(cfg.model, "claude-sonnet-4-20250514");
    assert.equal(cfg.timeout, 60);
  });
});

test("getEnabledAiProviders: 只返回 enabled 为真的提供商", () => {
  withConfig(({ cm }) => {
    assert.deepEqual(cm.getEnabledAiProviders().sort(), ["anthropic", "gemini"]);
    cm.setAiProviderEnabled("anthropic", false);
    assert.deepEqual(cm.getEnabledAiProviders(), ["gemini"]);
  });
});

test("账号管理配置的默认值与 Python 一致", () => {
  withConfig(({ cm }) => {
    assert.equal(cm.getLoginConcurrency(), 3);
    assert.equal(cm.getLoginMaxRetries(), 2);
    assert.equal(cm.getLoginRetryDelay(), 3);
    assert.equal(cm.getLoginTimeout(), 120);
    assert.equal(cm.getAiDefaultProvider(), "gemini");
  });
});

test("getLlmConfig: 汇总 provider / api_key / model / max_tokens / timeout", () => {
  withConfig(({ cm }) => {
    cm.setAiProviderApiKey("gemini", "KEY");
    const llm = cm.getLlmConfig();
    assert.equal(llm.provider, "gemini");
    assert.equal(llm.api_key, "KEY");
    assert.equal(llm.model, "gemini-2.5-flash");
    assert.equal(llm.max_tokens, 8192);
    assert.equal(llm.timeout, 60);
  });
});
