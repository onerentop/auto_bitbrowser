/**
 * 后端进程的运行上下文 —— 单例依赖容器
 *
 * 数据根目录（accounts.db / config.json 所在处）由主进程决定，经环境变量
 * ABB_DATA_ROOT 传进来（见 app/main/data-root.ts）。这里不自己猜路径：
 * src/core/config-manager.ts 的 getBasePath() 依赖 import.meta.url，打包后会指到 out/ 下。
 *
 * 数据库、配置都是**惰性**创建：第一次用到时才打开。这样即使库文件损坏，
 * 后端进程也能起来，错误以信封形式返回给界面，而不是启动即崩。
 */
import { join } from "node:path";
import { ConfigManager } from "../../src/core/config-manager.ts";
import { openDb, type Db } from "../../src/db/connection.ts";
import { initDb } from "../../src/db/schema.ts";
import { AccountRepository } from "../../src/db/account-repository.ts";
import { IxBrowserClient } from "../../src/ixbrowser/client.ts";
import { TaskRunner, type TaskEmit } from "./task-runner.ts";

export const DATA_ROOT_ENV = "ABB_DATA_ROOT";

export interface HostContext {
  readonly dataRoot: string;
  readonly dbPath: string;
  readonly configFile: string;
  config(): ConfigManager;
  db(): Db;
  accountRepo(): AccountRepository;
  ix(): IxBrowserClient;
  readonly tasks: TaskRunner;
  log(message: string): void;
}

export interface HostContextOptions {
  dataRoot: string;
  emit: TaskEmit;
  log?: (message: string) => void;
  /** 测试注入：替换数据库打开方式（例如 :memory:） */
  openDatabase?: (path: string) => Db;
  ixClient?: IxBrowserClient;
}

function lazy<T>(factory: () => T): () => T {
  let made = false;
  let value: T;
  return () => {
    if (!made) {
      value = factory();
      made = true;
    }
    return value;
  };
}

export function createHostContext(options: HostContextOptions): HostContext {
  const log = options.log ?? ((m: string) => process.stdout.write(`${m}\n`));
  const dbPath = join(options.dataRoot, "accounts.db");
  const configFile = join(options.dataRoot, "config.json");
  const open = options.openDatabase ?? ((p: string) => openDb(p));

  const db = lazy(() => {
    const handle = open(dbPath);
    // 对标 Python 各页面加载前的 DBManager.init_db()：建表 + 补列，幂等
    initDb(handle);
    return handle;
  });

  return {
    dataRoot: options.dataRoot,
    dbPath,
    configFile,
    config: lazy(() => new ConfigManager({ configFile, log })),
    db,
    accountRepo: lazy(() => new AccountRepository(db())),
    ix: lazy(() => options.ixClient ?? new IxBrowserClient()),
    tasks: new TaskRunner({ emit: options.emit }),
    log,
  };
}
