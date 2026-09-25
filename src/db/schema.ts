/**
 * 建表与列迁移
 *
 * SQL 语句：
 *   - 7 张表（accounts / proxies / proxy_window_bindings / account_refresh_tasks / account_refresh_task_items /
 *     task_run_history / task_run_items）
 *   - accounts 的 22 个 `ALTER TABLE ADD COLUMN`，列已存在时吞掉错误
 * 各类修改历史表不在这里建，由 HistoryRepository.initTable 按需创建。
 */
import type { Db } from "./connection.ts";

const CREATE_ACCOUNTS = `
                CREATE TABLE IF NOT EXISTS accounts (
                    email TEXT PRIMARY KEY,
                    password TEXT,
                    recovery_email TEXT,
                    secret_key TEXT,
                    verification_link TEXT,
                    status TEXT DEFAULT 'pending',
                    message TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `;

/** accounts 表的迁移列，顺序不可调整 */
export const ACCOUNT_MIGRATIONS: readonly string[] = [
  "ALTER TABLE accounts ADD COLUMN sheerid_steps INTEGER DEFAULT 0",
  "ALTER TABLE accounts ADD COLUMN last_failed_step TEXT",
  "ALTER TABLE accounts ADD COLUMN last_error TEXT",
  // Sub2API 集成字段 (V2.0)
  "ALTER TABLE accounts ADD COLUMN sub2api_account_id INTEGER",
  "ALTER TABLE accounts ADD COLUMN sub2api_status TEXT DEFAULT 'not_linked'",
  "ALTER TABLE accounts ADD COLUMN sub2api_session_id TEXT",
  "ALTER TABLE accounts ADD COLUMN login_status TEXT DEFAULT 'not_logged'",
  "ALTER TABLE accounts ADD COLUMN last_login_at TIMESTAMP",
  "ALTER TABLE accounts ADD COLUMN browser_profile_id TEXT",
  // 403 解锁状态字段
  "ALTER TABLE accounts ADD COLUMN unlock_status TEXT DEFAULT 'none'",
  "ALTER TABLE accounts ADD COLUMN validation_url TEXT",
  // Google One Pro 会员状态
  "ALTER TABLE accounts ADD COLUMN is_pro TEXT DEFAULT 'unknown'",
  "ALTER TABLE accounts ADD COLUMN family_member_count INTEGER DEFAULT 0",
  "ALTER TABLE accounts ADD COLUMN family_sharing_enabled TEXT DEFAULT 'unknown'",
  // 家庭组信息刷新扩展字段
  "ALTER TABLE accounts ADD COLUMN pro_plan_name TEXT DEFAULT ''",
  "ALTER TABLE accounts ADD COLUMN family_role TEXT DEFAULT 'unknown'",
  "ALTER TABLE accounts ADD COLUMN family_manager_email TEXT DEFAULT ''",
  "ALTER TABLE accounts ADD COLUMN has_family_group TEXT DEFAULT 'unknown'",
  "ALTER TABLE accounts ADD COLUMN account_country TEXT DEFAULT ''",
  "ALTER TABLE accounts ADD COLUMN family_slots_left INTEGER DEFAULT -1",
  "ALTER TABLE accounts ADD COLUMN family_info_refreshed_at TIMESTAMP",
  "ALTER TABLE accounts ADD COLUMN family_info_refresh_error TEXT",
];

const CREATE_PROXIES = `
                CREATE TABLE IF NOT EXISTS proxies (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    proxy_type TEXT DEFAULT 'socks5',
                    username TEXT,
                    password TEXT,
                    host TEXT NOT NULL,
                    port TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_check_at TIMESTAMP,
                    last_check_ok INTEGER,
                    last_check_error TEXT,
                    outbound_ip TEXT
                )
            `;

/** proxies 表的迁移列：老库补列（幂等） */
const PROXY_MIGRATIONS: readonly string[] = [
  "ALTER TABLE proxies ADD COLUMN last_check_at TIMESTAMP",
  "ALTER TABLE proxies ADD COLUMN last_check_ok INTEGER",
  "ALTER TABLE proxies ADD COLUMN last_check_error TEXT",
  "ALTER TABLE proxies ADD COLUMN outbound_ip TEXT",
];

const CREATE_PROXY_WINDOW_BINDINGS = `
                CREATE TABLE IF NOT EXISTS proxy_window_bindings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    proxy_id INTEGER NOT NULL,
                    browser_id TEXT NOT NULL,
                    email TEXT,
                    bound_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (proxy_id) REFERENCES proxies(id) ON DELETE CASCADE,
                    UNIQUE(browser_id)
                )
            `;

const CREATE_REFRESH_TASKS = `
                CREATE TABLE IF NOT EXISTS account_refresh_tasks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_type TEXT NOT NULL DEFAULT 'family_info_refresh',
                    task_mode TEXT NOT NULL DEFAULT 'full',
                    status TEXT NOT NULL DEFAULT 'pending',
                    scope_type TEXT DEFAULT 'selected',
                    total_count INTEGER DEFAULT 0,
                    success_count INTEGER DEFAULT 0,
                    failed_count INTEGER DEFAULT 0,
                    progress_current INTEGER DEFAULT 0,
                    progress_percent REAL DEFAULT 0.0,
                    started_at TIMESTAMP,
                    finished_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    created_by TEXT DEFAULT 'gui',
                    note TEXT
                )
            `;

const CREATE_REFRESH_TASK_ITEMS = `
                CREATE TABLE IF NOT EXISTS account_refresh_task_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id INTEGER NOT NULL,
                    email TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    error_message TEXT,
                    is_pro TEXT,
                    pro_plan_name TEXT,
                    family_role TEXT,
                    family_manager_email TEXT,
                    has_family_group TEXT,
                    family_member_count INTEGER,
                    family_slots_left INTEGER,
                    account_country TEXT,
                    started_at TIMESTAMP,
                    finished_at TIMESTAMP,
                    FOREIGN KEY (task_id) REFERENCES account_refresh_tasks(id) ON DELETE CASCADE
                )
            `;

/** 批量任务运行结果（任务级）—— 本地新增能力 */
const CREATE_TASK_RUN_HISTORY = `
                CREATE TABLE IF NOT EXISTS task_run_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_type TEXT NOT NULL,
                    label TEXT,
                    outcome TEXT,
                    started_at TIMESTAMP,
                    finished_at TIMESTAMP,
                    total INTEGER DEFAULT 0,
                    success_count INTEGER DEFAULT 0,
                    failed_count INTEGER DEFAULT 0,
                    error TEXT,
                    params TEXT
                )
            `;

const CREATE_TASK_RUN_ITEMS = `
                CREATE TABLE IF NOT EXISTS task_run_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id INTEGER NOT NULL,
                    item_key TEXT,
                    status TEXT,
                    message TEXT,
                    FOREIGN KEY (run_id) REFERENCES task_run_history(id) ON DELETE CASCADE
                )
            `;

/** task_run_history 表的迁移列（老库补 params） */
const TASK_RUN_MIGRATIONS: readonly string[] = [
  "ALTER TABLE task_run_history ADD COLUMN params TEXT",
];

/** 列已存在（duplicate column name）时 SQLite 报的错误 */
function isDuplicateColumn(error: unknown): boolean {
  return error instanceof Error && /duplicate column name/i.test(error.message);
}

/** 幂等执行一批建列/加列语句：只吞「列已存在」，其它错误照常抛出 */
function applyMigrations(db: Db, sqls: readonly string[]): void {
  for (const sql of sqls) {
    try {
      db.exec(sql);
    } catch (error) {
      if (!isDuplicateColumn(error)) throw error;
    }
  }
}

/**
 * 建表 + 迁移，可重复调用（幂等）。
 *
 * 有意差异：只吞「列已存在」的错误，
 * 其它错误（库只读、磁盘满）照常抛出——否则会以缺列状态继续跑，后面的 SQL 才报错，难以定位。
 */
export function initDb(db: Db): void {
  db.exec(CREATE_ACCOUNTS);
  applyMigrations(db, ACCOUNT_MIGRATIONS);
  db.exec(CREATE_PROXIES);
  applyMigrations(db, PROXY_MIGRATIONS);
  db.exec(CREATE_PROXY_WINDOW_BINDINGS);
  db.exec(CREATE_REFRESH_TASKS);
  db.exec(CREATE_REFRESH_TASK_ITEMS);
  db.exec(CREATE_TASK_RUN_HISTORY);
  applyMigrations(db, TASK_RUN_MIGRATIONS);
  db.exec(CREATE_TASK_RUN_ITEMS);
}
