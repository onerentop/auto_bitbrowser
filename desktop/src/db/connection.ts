/**
 * SQLite 连接层（Node 重写）
 *
 * 选型说明：使用 Node 22 内置的 node:sqlite 而非 better-sqlite3。
 * 理由：better-sqlite3 是原生模块，需要预编译二进制或本机工具链，
 * 在 Electron 下还要 electron-rebuild；node:sqlite 零依赖、同步 API 一致。
 * 代价：目前仍是 experimental，运行需 --experimental-sqlite（Node 22）。
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

/** 数据库路径：项目根目录下的 accounts.db */
export function resolveDbPath(projectRoot: string): string {
  return path.join(projectRoot, "accounts.db");
}

export interface DbOptions {
  /** 只读模式，POC 阶段默认开启，避免误写生产库 */
  readonly?: boolean;
}

export type Db = DatabaseSync;

export function openDb(dbPath: string, options: DbOptions = {}): Db {
  const readonly = options.readonly ?? false;
  const db = new DatabaseSync(dbPath, { readOnly: readonly });
  // WAL 能显著降低读写互斥
  if (!readonly) db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}
