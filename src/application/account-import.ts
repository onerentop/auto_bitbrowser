/**
 * 账号管理页「批量导入」的用例（原在设置页「账号数据」，已迁到账号管理页）
 *
 * 整批包在一个事务里（只为减少磁盘同步次数）。计数规则（有意如此）：
 *   - upsertAccount 返回 false（写库失败被仓储吞掉）计为 fail，计数更真实；
 *   - 循环中若抛出未被 upsertAccount 吞掉的异常，整批回滚并把错误抛给界面，已写入的条目也不保留。
 */
import type { ImportResultDto } from "../../app/shared/channels/settings.ts";
import { buildAccountImportUpsert, type ImportedAccount } from "../../app/shared/logic/settings-data.ts";
import type { AccountRepository } from "../db/account-repository.ts";

export function importAccounts(
  repo: Pick<AccountRepository, "transaction" | "getAccountByEmail" | "upsertAccount">,
  rows: readonly ImportedAccount[],
): ImportResultDto {
  return repo.transaction(() => {
    let success = 0;
    let fail = 0;
    for (const data of rows) {
      const exists = repo.getAccountByEmail(data.email) !== null;
      if (repo.upsertAccount(buildAccountImportUpsert(data, exists))) success += 1;
      else fail += 1;
    }
    return { success_count: success, fail_count: fail };
  });
}
