/**
 * TOTP 密钥导入页
 *
 * 布局：页头（标题 + 说明 + 「导入选中账号」）→ 导入面板（方式切换 + muted 说明 + QR / 文本输入）
 *       → 结果面板（全选栏 + 状态 + 结果表格，占满剩余高度）。
 * 日志区由底部全局任务坞替代，界面侧日志用 logLocal。
 * 页面切走不卸载，解析结果与勾选状态会保留。
 *
 * 流程：图片 → 渲染层 jsQR 识别 → abb/totp/parseUris → abb/totp/match → 勾选 → abb/totp/import（后台任务）
 *       文本 → abb/totp/parseText → abb/totp/match → 勾选 → abb/totp/import
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactElement,
} from "react";
import { App, Button, Checkbox, Input, Progress, Segmented, Space, Typography } from "antd";
import {
  CheckOutlined,
  DeleteOutlined,
  FileTextOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  QrcodeOutlined,
  SearchOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import {
  TOTP_IMPORT_TASK_TYPE,
  type TotpEntry,
  type TotpImportItem,
  type TotpMatchRow,
} from "../../../shared/channels/totp.ts";
import { IPC, describeError, invoke } from "../lib/ipc.ts";
import { logLocal, markTaskStarted, onTaskFinished, useTaskState } from "../stores/task.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import { Panel, Section } from "../components/Section.tsx";
import { useTokens } from "../theme/tokens.ts";
import { decodeQrFromFile, IMAGE_ACCEPT, isImageFileName } from "./totp/qr-decode.ts";
import { importConfirmMessage, importFinishedNotice, isImportResult } from "./totp/messages.ts";
import { ResultTable, type ResultRow } from "./totp/ResultTable.tsx";

type Mode = "qr" | "text";

/** 说明区文案（QR 模式按有序列表渲染，序号由 <ol> 提供） */
const QR_HELP = [
  "打开手机 Google Authenticator → 右上角菜单 → 导出账号",
  "对生成的 QR 码截图并保存到电脑",
  "点击「选择图片」或直接把截图拖放到此窗口",
];
const TEXT_HELP = [
  "每行一条记录，格式：邮箱----密码----密钥（用四个短横线 ---- 分隔）",
  "示例：example@gmail.com----password123----ABCDEFGHIJKLMNOP",
];
/** 文本输入框占位 */
const TEXT_PLACEHOLDER =
  "在此粘贴账号信息，每行一条，格式：\n" +
  "邮箱----密码----密钥\n\n" +
  "示例：\n" +
  "example1@gmail.com----pass123----ABCDEFGHIJKLMNOP\n" +
  "example2@gmail.com----pass456----QRSTUVWXYZ123456";

function Multiline({ text }: { text: string }): ReactElement {
  return <div style={{ whiteSpace: "pre-wrap" }}>{text}</div>;
}

/** 表格重建后的默认勾选：只勾「可导入」 */
function defaultSelection(matches: readonly TotpMatchRow[]): Set<number> {
  const out = new Set<number>();
  matches.forEach((m, i) => {
    if (m.status === "can_import") out.add(i);
  });
  return out;
}

export function TotpImportPage(): ReactElement {
  const { modal, notification } = App.useApp();
  const { running } = useTaskState();
  const busy = running !== null;
  const t = useTokens();

  const [mode, setMode] = useState<Mode>("qr");
  const [entries, setEntries] = useState<TotpEntry[]>([]);
  const [matches, setMatches] = useState<TotpMatchRow[]>([]);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [onlyMatched, setOnlyMatched] = useState(true);
  const [statusText, setStatusText] = useState("就绪 - 请选择导入方式");
  const [scan, setScan] = useState<{ current: number; total: number } | null>(null);
  const [text, setText] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const singleInput = useRef<HTMLInputElement>(null);
  const multiInput = useRef<HTMLInputElement>(null);

  const notify = useCallback(
    (level: "info" | "warning" | "error", title: string, content: string): void => {
      notification[level]({ message: title, description: <Multiline text={content} /> });
    },
    [notification],
  );

  // 依赖检查：jsQR 随应用打包，始终就绪
  const depChecked = useRef(false);
  useEffect(() => {
    if (depChecked.current) return;
    depChecked.current = true;
    logLocal("QR 扫描依赖已就绪");
  }, []);

  // ---------- 匹配 ----------

  /** 最新的提取结果（任务结束回调里刷新匹配要用） */
  const entriesRef = useRef<TotpEntry[]>([]);
  const matchSeq = useRef(0);

  const matchWithDatabase = useCallback(
    async (list: TotpEntry[]): Promise<void> => {
      const seq = ++matchSeq.current;
      logLocal("开始匹配数据库账号...");
      try {
        const r = await invoke(IPC.invoke.totpMatch, list.map((e) => ({ email: e.email })));
        if (seq !== matchSeq.current) return;
        const { can_import, has_secret, no_match } = r.counts;
        logLocal(`  可导入: ${can_import}`);
        logLocal(`  已有密钥: ${has_secret}`);
        logLocal(`  未匹配: ${no_match}`);
        setStatusText(`可导入: ${can_import} | 已有密钥: ${has_secret} | 未匹配: ${no_match}`);
        entriesRef.current = list;
        setEntries(list);
        setMatches(r.rows);
        // 表格重建，勾选恢复默认
        setSelected(defaultSelection(r.rows));
      } catch (e) {
        if (seq !== matchSeq.current) return;
        logLocal(`匹配数据库账号失败: ${describeError(e)}`);
        notify("error", "错误", `匹配数据库账号失败:\n${describeError(e)}`);
      }
    },
    [notify],
  );

  /** 刷新匹配结果 */
  const refreshMatch = useCallback((): void => {
    if (entriesRef.current.length > 0) void matchWithDatabase(entriesRef.current);
  }, [matchWithDatabase]);

  // 任务结束：弹完成汇总并刷新匹配
  useEffect(
    () =>
      onTaskFinished((e) => {
        if (e.type !== TOTP_IMPORT_TASK_TYPE) return;
        if (isImportResult(e.result)) {
          const n = importFinishedNotice(e.result);
          notify(n.level, n.title, n.message);
        } else if (e.outcome === "failed") {
          notify("error", "导入失败", e.error ?? "未知错误");
        }
        refreshMatch();
      }),
    [notify, refreshMatch],
  );

  // ---------- 模式切换 ----------

  const changeMode = (next: Mode): void => {
    setMode(next);
    setStatusText(next === "qr" ? "就绪 - 请选择 QR 码截图" : "就绪 - 请粘贴账号文本");
  };

  // ---------- QR 码导入 ----------

  const scanning = scan !== null;
  /** 识别进行中（用 ref 防重入，避免依赖 state 的闭包过期） */
  const scanningRef = useRef(false);

  /**
   * 逐张识别并解析。
   * 这里在渲染层异步逐张识别，识别期间界面可操作。
   */
  const processImages = useCallback(
    async (files: File[]): Promise<void> => {
      if (files.length === 0 || scanningRef.current) return;
      scanningRef.current = true;
      setScan({ current: 0, total: files.length });
      const all: TotpEntry[] = [];
      try {
        for (let i = 0; i < files.length; i++) {
          const file = files[i] as File;
          setScan({ current: i, total: files.length });
          logLocal(`扫描: ${file.name}`);
          try {
            const uri = await decodeQrFromFile(file);
            const r = await invoke(IPC.invoke.totpParseUris, [{ uri, source: file.name }]);
            all.push(...r.entries);
            const item = r.items[0];
            if (item && item.count > 0) logLocal(`  找到 ${item.count} 个账号`);
            for (const err of item?.errors ?? []) logLocal(`  警告: ${err}`);
          } catch (e) {
            logLocal(`  处理失败: ${describeError(e)}`);
          }
        }
      } finally {
        scanningRef.current = false;
        setScan(null);
      }

      if (all.length === 0) {
        logLocal("未能从图片中提取任何账号");
        notify(
          "warning",
          "未找到账号",
          "未能从选择的图片中提取 TOTP 账号。\n\n请确保图片包含有效的 Google Authenticator 导出 QR 码。",
        );
        return;
      }
      logLocal(`共提取 ${all.length} 个账号`);
      await matchWithDatabase(all);
    },
    [notify, matchWithDatabase],
  );

  const onFilesChosen = (input: HTMLInputElement | null): void => {
    if (!input?.files) return;
    const files = Array.from(input.files);
    // 清空值，允许再次选择同一文件
    input.value = "";
    void processImages(files);
  };

  // 拖放：仅在 QR 模式下接受
  const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer.types).includes("Files");
  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (mode !== "qr" || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!dragOver) setDragOver(true);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>): void => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(false);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    setDragOver(false);
    if (mode !== "qr") return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).filter((f) => isImageFileName(f.name));
    if (files.length > 0) void processImages(files);
  };

  // ---------- 文本导入 ----------

  const [parsing, setParsing] = useState(false);
  const parseText = async (): Promise<void> => {
    if (!text.trim()) {
      notify("warning", "提示", "请先粘贴账号信息");
      return;
    }
    setParsing(true);
    try {
      const r = await invoke(IPC.invoke.totpParseText, text);
      for (const line of r.logs) logLocal(line);
      if (r.entries.length === 0) {
        notify("warning", "解析失败", `未能解析任何有效账号\n\n共 ${r.errorLines.length} 行格式错误`);
        return;
      }
      logLocal(`共解析 ${r.entries.length} 个有效账号`);
      await matchWithDatabase(r.entries);
    } catch (e) {
      logLocal(`解析失败: ${describeError(e)}`);
      notify("error", "错误", `解析文本失败:\n${describeError(e)}`);
    } finally {
      setParsing(false);
    }
  };

  const clearText = (): void => {
    setText("");
    logLocal("已清空文本输入");
  };

  // ---------- 表格与勾选 ----------

  const visibleRows = useMemo<ResultRow[]>(
    () =>
      entries.flatMap((entry, index) => {
        const match = matches[index];
        if (!match) return [];
        if (onlyMatched && match.status === "no_match") return [];
        return [{ index, entry, match }];
      }),
    [entries, matches, onlyMatched],
  );

  const changeOnlyMatched = (checked: boolean): void => {
    setOnlyMatched(checked);
    // 切换过滤会重建表格，勾选恢复默认
    setSelected(defaultSelection(matches));
  };

  const selectableRows = visibleRows.filter((r) => r.match.status !== "no_match");
  const checkedRows = visibleRows.filter((r) => selected.has(r.index));
  const allChecked = selectableRows.length > 0 && selectableRows.every((r) => selected.has(r.index));
  const someChecked = !allChecked && selectableRows.some((r) => selected.has(r.index));

  /** 全选只作用于可勾选的行 */
  const toggleAll = (checked: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of selectableRows) {
        if (checked) next.add(r.index);
        else next.delete(r.index);
      }
      return next;
    });
  };

  // ---------- 导入 ----------

  const importPending = useRef(false);
  const startImport = async (): Promise<void> => {
    if (importPending.current) return;
    // 只取可见且匹配到数据库账号的勾选行
    const chosen = checkedRows.filter((r) => r.match.matchedEmail !== null && r.entry.email);
    if (chosen.length === 0) {
      notify("info", "提示", "请选择要导入的账号");
      return;
    }
    importPending.current = true;
    try {
      const msg = importConfirmMessage(chosen.map((r) => ({ entry: r.entry, status: r.match.status })));
      const ok = await new Promise<boolean>((resolve) => {
        modal.confirm({
          title: "确认导入",
          content: <Multiline text={msg} />,
          okText: "确定",
          cancelText: "取消",
          width: 480,
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
      if (!ok) return;
      // 只传解析出的数据；任务内按数据库当前状态重新匹配
      const items: TotpImportItem[] = chosen.map((r) => {
        const item: TotpImportItem = { email: r.entry.email as string, secret: r.entry.secret, kind: r.entry.kind };
        if (r.entry.kind === "text" && r.entry.password) item.password = r.entry.password;
        return item;
      });
      const info = await invoke(IPC.invoke.totpImport, items);
      markTaskStarted(info);
    } catch (e) {
      logLocal(`错误: ${describeError(e)}`);
      notify("error", "错误", `导入失败:\n${describeError(e)}`);
    } finally {
      importPending.current = false;
    }
  };

  // ---------- 渲染 ----------

  const runningImport = running?.type === TOTP_IMPORT_TASK_TYPE ? running : null;
  const toolbarRow = { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" } as const;

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        height: "100%",
        minHeight: 560,
        borderRadius: 8,
        // 拖入图片时的落点提示（仅 QR 模式）
        outline: dragOver ? `2px dashed ${t.indigo}` : undefined,
        outlineOffset: 4,
      }}
    >
      <PageHeader
        title="导入 TOTP 密钥"
        description="从 Google Authenticator 导出的 QR 码截图或账号文本中读出 2FA 密钥，导入到匹配的数据库账号。"
        extra={
          <Button
            type="primary"
            icon={<CheckOutlined />}
            disabled={visibleRows.length === 0 || busy || scanning}
            onClick={() => void startImport()}
          >
            导入选中账号
          </Button>
        }
      />

      {/* 导入区：方式切换 + 说明 + 对应的输入 */}
      <Panel>
        <Section
          first
          title={mode === "qr" ? "从 QR 码截图导入" : "从文本导入"}
          extra={
            <Segmented<Mode>
              value={mode}
              onChange={changeMode}
              options={[
                { value: "qr", label: "QR 码导入", icon: <QrcodeOutlined /> },
                { value: "text", label: "文本导入", icon: <FileTextOutlined /> },
              ]}
            />
          }
        >
          {mode === "qr" ? (
            <>
              <ol style={{ margin: "0 0 12px", paddingLeft: 20, color: t.muted }}>
                {QR_HELP.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ol>
              <Space wrap>
                <input ref={singleInput} type="file" accept={IMAGE_ACCEPT} hidden onChange={(e) => onFilesChosen(e.currentTarget)} />
                <input
                  ref={multiInput}
                  type="file"
                  accept={IMAGE_ACCEPT}
                  multiple
                  hidden
                  onChange={(e) => onFilesChosen(e.currentTarget)}
                />
                <Button
                  icon={<FolderOpenOutlined />}
                  title="选择单个 QR 码截图"
                  disabled={scanning}
                  onClick={() => singleInput.current?.click()}
                >
                  选择图片
                </Button>
                <Button
                  icon={<FolderAddOutlined />}
                  title="选择多个 QR 码截图"
                  disabled={scanning}
                  onClick={() => multiInput.current?.click()}
                >
                  批量选择
                </Button>
              </Space>
            </>
          ) : (
            <>
              <div style={{ color: t.muted, marginBottom: 12 }}>
                {TEXT_HELP.map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </div>
              <Input.TextArea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={TEXT_PLACEHOLDER}
                aria-label="账号文本"
                autoSize={{ minRows: 5, maxRows: 7 }}
                spellCheck={false}
              />
              <Space wrap style={{ marginTop: 12 }}>
                <Button
                  icon={<SearchOutlined />}
                  title="解析输入的文本并匹配数据库账号"
                  loading={parsing}
                  onClick={() => void parseText()}
                >
                  解析文本
                </Button>
                <Button type="text" icon={<DeleteOutlined />} onClick={clearText}>
                  清空文本
                </Button>
              </Space>
            </>
          )}
        </Section>
      </Panel>

      {/* 结果面板：全选栏 + 状态 + 表格 */}
      <Panel fill>
        <div style={{ ...toolbarRow, justifyContent: "space-between" }}>
          <div style={toolbarRow}>
            <Checkbox
              checked={allChecked}
              indeterminate={someChecked}
              disabled={selectableRows.length === 0}
              title="全选/取消全选可导入的账号"
              onChange={(e) => toggleAll(e.target.checked)}
            >
              全选
            </Checkbox>
            <Typography.Text type="secondary">已选 {checkedRows.length} 个</Typography.Text>
            <Typography.Text type="secondary">{statusText}</Typography.Text>
            {scan && (
              <Progress
                style={{ width: 200, margin: 0 }}
                size="small"
                percent={Math.round((scan.current / Math.max(scan.total, 1)) * 100)}
                format={() => `${scan.current}/${scan.total}`}
              />
            )}
            {runningImport && runningImport.total > 0 && (
              <Progress
                style={{ width: 200, margin: 0 }}
                size="small"
                percent={Math.round((runningImport.current / runningImport.total) * 100)}
                format={() => `${runningImport.current}/${runningImport.total}`}
              />
            )}
          </div>
          <div style={toolbarRow}>
            <Checkbox checked={onlyMatched} onChange={(e) => changeOnlyMatched(e.target.checked)}>
              仅显示可匹配账号
            </Checkbox>
            <Button icon={<SyncOutlined />} onClick={refreshMatch}>
              刷新匹配
            </Button>
          </div>
        </div>

        <ResultTable rows={visibleRows} selected={selected} onSelectedChange={setSelected} />
      </Panel>
    </div>
  );
}
