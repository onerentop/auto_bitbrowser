/**
 * src/engine/stagehand-config.ts —— 对标 core/stagehand_engine/config.py 的回落优先级
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MODEL_NAME,
  getConfigFromEnv,
  getConfigFromManager,
  getStagehandConfig,
  registerStagehandConfigSource,
} from "../src/engine/stagehand-config.ts";

function source({ provider = "gemini", key = "k-mgr", model = "gemini-2.5-flash", base = "" } = {}) {
  return {
    getAiDefaultProvider: () => provider,
    getAiProviderApiKey: () => key,
    getAiProviderModel: () => model,
    getAiProviderBaseUrl: () => base,
  };
}

test("getConfigFromManager：provider 映射、缺 model 用该 provider 默认模型", () => {
  assert.deepEqual(getConfigFromManager(source()), {
    modelName: "google/gemini-2.5-flash",
    apiKey: "k-mgr",
    baseUrl: null,
  });
  assert.equal(getConfigFromManager(source({ provider: "anthropic", model: "" })).modelName, "anthropic/claude-3-5-sonnet");
});

test("getConfigFromManager：无 provider / 无 key / 读取异常 / 未注册 → null", () => {
  assert.equal(getConfigFromManager(source({ provider: "" })), null);
  assert.equal(getConfigFromManager(source({ key: "" })), null);
  const boom = { ...source(), getAiDefaultProvider: () => { throw new Error("x"); } };
  assert.equal(getConfigFromManager(boom), null);
  assert.equal(getConfigFromManager(null), null);
});

test("getConfigFromEnv：无 MODEL_API_KEY 为 null；MODEL_NAME 缺省用默认模型", () => {
  assert.equal(getConfigFromEnv({}), null);
  assert.deepEqual(getConfigFromEnv({ MODEL_API_KEY: "e" }), { modelName: DEFAULT_MODEL_NAME, apiKey: "e", baseUrl: null });
});

test("getStagehandConfig：显式参数 > ConfigManager > 环境变量 > 默认，各字段独立回落", () => {
  const env = { MODEL_API_KEY: "k-env", MODEL_NAME: "openai/gpt-4o", MODEL_BASE_URL: "http://env" };
  // 只给了 model：key 来自 ConfigManager，base 来自环境变量
  assert.deepEqual(getStagehandConfig({ modelName: "anthropic/x", source: source(), env }), {
    modelName: "anthropic/x",
    apiKey: "k-mgr",
    baseUrl: "http://env",
  });
  // 空串视为缺失（Python `if not x`）
  assert.equal(getStagehandConfig({ modelName: "", apiKey: "", source: source(), env: {} }).apiKey, "k-mgr");
  // ConfigManager 不可用 → 环境变量
  assert.deepEqual(getStagehandConfig({ source: null, env }), { modelName: "openai/gpt-4o", apiKey: "k-env", baseUrl: "http://env" });
  // 什么都没有 → 默认模型、key 为 null
  assert.deepEqual(getStagehandConfig({ source: null, env: {} }), { modelName: DEFAULT_MODEL_NAME, apiKey: null, baseUrl: null });
});

test("registerStagehandConfigSource：注册后作为默认来源，取消注册后失效", () => {
  try {
    registerStagehandConfigSource(() => source({ key: "k-reg" }));
    assert.equal(getStagehandConfig({ env: {} }).apiKey, "k-reg");
    registerStagehandConfigSource(null);
    assert.equal(getStagehandConfig({ env: {} }).apiKey, null);
  } finally {
    registerStagehandConfigSource(null);
  }
});
