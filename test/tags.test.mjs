/**
 * ixBrowser 标签纯逻辑（src/application/tags.ts）
 *
 * 真机事实：tag_id 是空格分隔的多个 id；tag_name 也是空格分隔，但标题本身可能含空格，
 * 所以解析一律走 tag_id + 词表映射。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseTagIds, resolveTags, tagIdsByWindow, tagTitles, unknownTagIds } from "../src/application/tags.ts";

const VOCAB = [
  { id: 142399, title: "已修改2fa", color: "#67C23A" },
  { id: 140180, title: "已使用", color: "#67C23A" },
  { id: 151612, title: "Google Cloud不可用", color: "#67C23A" },
];

test("parseTagIds：空格分隔、去重、丢弃非法项；空值给空数组", () => {
  assert.deepEqual(parseTagIds("142399 140180 144969"), [142399, 140180, 144969]);
  assert.deepEqual(parseTagIds("  142399   142399  140180  "), [142399, 140180], "去重并忽略多余空白");
  assert.deepEqual(parseTagIds(""), []);
  assert.deepEqual(parseTagIds("   "), []);
  assert.deepEqual(parseTagIds(null), []);
  assert.deepEqual(parseTagIds(undefined), []);
  assert.deepEqual(parseTagIds(142399), [142399], "单值数字形态");
  assert.deepEqual(parseTagIds("142399 abc -5 0 3.5 140180"), [142399, 140180], "非数字 / 负数 / 0 / 小数全部丢弃");
});

test("tagIdsByWindow：按窗口 ID 建映射；没有标签的窗口不入表；非法窗口跳过", () => {
  const m = tagIdsByWindow([
    { profile_id: 7, tag_id: "142399 140180" },
    { profile_id: 8, tag_id: "" },
    { profile_id: 9 },
    { profile_id: "10", tag_id: "140180" },
    null,
    { tag_id: "140180" },
    { profile_id: 11, tag_id: "140180" },
  ]);
  assert.deepEqual(m.get("7"), [142399, 140180]);
  assert.equal(m.has("8"), false, "空标签不入表");
  assert.equal(m.has("9"), false);
  assert.equal(m.has("10"), false, "profile_id 不是数字时跳过（返回的是数字类型）");
  assert.deepEqual(m.get("11"), [140180]);
  assert.equal(m.size, 2);
});

test("resolveTags：按 id 取词表项，顺序跟随 ids；词表里没有的 id 丢弃", () => {
  assert.deepEqual(
    resolveTags([140180, 151612], VOCAB).map((t) => [t.id, t.title]),
    [
      [140180, "已使用"],
      [151612, "Google Cloud不可用"],
    ],
  );
  assert.deepEqual(resolveTags([999999], VOCAB), [], "词表里没有的 id 丢弃");
  assert.deepEqual(resolveTags([], VOCAB), []);
});

test("tagTitles：写成名字数组（标题含空格也原样作为一个元素）", () => {
  assert.deepEqual(tagTitles([142399, 151612], VOCAB), ["已修改2fa", "Google Cloud不可用"]);
  assert.deepEqual(tagTitles([999999, 140180], VOCAB), ["已使用"], "未知 id 不参与写入");
});

test("unknownTagIds：报出词表里不存在的 id（写入前校验用）", () => {
  assert.deepEqual(unknownTagIds([142399, 999999, 888888], VOCAB), [999999, 888888]);
  assert.deepEqual(unknownTagIds([142399, 140180], VOCAB), []);
});
