"""
TOTP 密钥导入 GUI

从 Google Authenticator 导出的 QR 码截图中提取 TOTP 密钥，
并匹配更新到数据库中没有 secret_key 的账号。

使用流程:
1. 用户从手机 Google Authenticator 导出账号（生成 QR 码）
2. 用户截图保存到电脑
3. 打开此界面，选择截图文件
4. 自动解析 QR 码中的 TOTP 密钥
5. 根据邮箱匹配数据库中的账号
6. 更新 secret_key 字段
"""

import os
from typing import List
from datetime import datetime

from PyQt6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QTableWidget, QTableWidgetItem, QHeaderView, QFileDialog,
    QMessageBox, QGroupBox, QTextEdit, QProgressBar, QCheckBox,
    QSplitter, QWidget, QAbstractItemView,
)
from PyQt6.QtCore import Qt
from PyQt6.QtGui import QColor, QDragEnterEvent, QDropEvent

from services.database import DBManager


class ImportTOTPDialog(QDialog):
    """TOTP 密钥导入对话框"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("导入 TOTP 密钥 (Google Authenticator)")
        self.setMinimumSize(900, 600)
        self.setAcceptDrops(True)  # 支持拖放

        self._extracted_accounts = []  # 提取的账号列表
        self._match_results = []  # 匹配结果

        self._init_ui()
        self._check_dependencies()

    def _init_ui(self):
        """初始化界面"""
        layout = QVBoxLayout(self)

        # 顶部说明
        help_text = QLabel(
            "📱 使用说明:\n"
            "1. 打开手机 Google Authenticator → 右上角菜单 → 导出账号 → 选择要导出的账号\n"
            "2. 对生成的 QR 码截图并保存到电脑\n"
            "3. 点击下方「选择图片」或直接拖放截图到此窗口\n"
            "4. 系统自动解析并匹配数据库中的账号"
        )
        help_text.setWordWrap(True)
        help_text.setStyleSheet("""
            QLabel {
                background-color: #E3F2FD;
                padding: 10px;
                border-radius: 5px;
                color: #1565C0;
            }
        """)
        layout.addWidget(help_text)

        # 工具栏
        toolbar = self._create_toolbar()
        layout.addWidget(toolbar)

        # 主内容区
        splitter = QSplitter(Qt.Orientation.Vertical)

        # 解析结果表格
        table_group = QGroupBox("解析结果")
        table_layout = QVBoxLayout(table_group)
        self.table = self._create_table()
        table_layout.addWidget(self.table)
        splitter.addWidget(table_group)

        # 日志区域
        log_group = QGroupBox("日志")
        log_layout = QVBoxLayout(log_group)
        self.log_text = QTextEdit()
        self.log_text.setReadOnly(True)
        self.log_text.setMaximumHeight(120)
        log_layout.addWidget(self.log_text)
        splitter.addWidget(log_group)

        splitter.setSizes([400, 120])
        layout.addWidget(splitter)

        # 进度条
        self.progress_bar = QProgressBar()
        self.progress_bar.setVisible(False)
        layout.addWidget(self.progress_bar)

        # 底部统计和操作
        bottom_layout = QHBoxLayout()

        self.status_label = QLabel("就绪 - 请选择 QR 码截图")
        bottom_layout.addWidget(self.status_label)

        bottom_layout.addStretch()

        self.btn_import = QPushButton("✅ 导入选中账号")
        self.btn_import.setEnabled(False)
        self.btn_import.setFixedWidth(150)
        self.btn_import.clicked.connect(self._on_import)
        bottom_layout.addWidget(self.btn_import)

        layout.addLayout(bottom_layout)

    def _create_toolbar(self) -> QWidget:
        """创建工具栏"""
        toolbar = QWidget()
        layout = QHBoxLayout(toolbar)
        layout.setContentsMargins(0, 0, 0, 0)

        # 选择图片按钮
        self.btn_select = QPushButton("📂 选择图片")
        self.btn_select.setFixedWidth(120)
        self.btn_select.clicked.connect(self._on_select_image)
        layout.addWidget(self.btn_select)

        # 批量选择
        self.btn_select_multiple = QPushButton("📂 批量选择")
        self.btn_select_multiple.setFixedWidth(100)
        self.btn_select_multiple.clicked.connect(self._on_select_multiple_images)
        layout.addWidget(self.btn_select_multiple)

        layout.addSpacing(20)

        # 全选/取消全选
        self.btn_select_all = QPushButton("☑️ 全选")
        self.btn_select_all.setFixedWidth(80)
        self.btn_select_all.clicked.connect(self._on_select_all)
        layout.addWidget(self.btn_select_all)

        self.btn_deselect_all = QPushButton("⬜ 取消全选")
        self.btn_deselect_all.setFixedWidth(100)
        self.btn_deselect_all.clicked.connect(self._on_deselect_all)
        layout.addWidget(self.btn_deselect_all)

        layout.addSpacing(20)

        # 仅显示匹配账号
        self.chk_only_matched = QCheckBox("仅显示可匹配账号")
        self.chk_only_matched.setChecked(True)
        self.chk_only_matched.stateChanged.connect(self._apply_filter)
        layout.addWidget(self.chk_only_matched)

        layout.addStretch()

        # 刷新按钮
        self.btn_refresh = QPushButton("🔄 刷新匹配")
        self.btn_refresh.setFixedWidth(100)
        self.btn_refresh.clicked.connect(self._refresh_match)
        layout.addWidget(self.btn_refresh)

        return toolbar

    def _create_table(self) -> QTableWidget:
        """创建结果表格"""
        table = QTableWidget()
        table.setColumnCount(7)
        table.setHorizontalHeaderLabels([
            "选择", "提取邮箱", "发行方", "密钥", "匹配账号", "当前密钥", "状态"
        ])

        # 设置列宽
        header = table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.Fixed)
        header.setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(2, QHeaderView.ResizeMode.Fixed)
        header.setSectionResizeMode(3, QHeaderView.ResizeMode.Fixed)
        header.setSectionResizeMode(4, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(5, QHeaderView.ResizeMode.Fixed)
        header.setSectionResizeMode(6, QHeaderView.ResizeMode.Fixed)

        table.setColumnWidth(0, 50)
        table.setColumnWidth(2, 80)
        table.setColumnWidth(3, 180)
        table.setColumnWidth(5, 100)
        table.setColumnWidth(6, 80)

        table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)

        return table

    def _check_dependencies(self):
        """检查依赖"""
        try:
            from core.totp_extractor.qr_scanner import check_dependencies
            available, error = check_dependencies()

            if not available:
                self.log(f"⚠️ {error}")
                self.btn_select.setEnabled(False)
                self.btn_select_multiple.setEnabled(False)
                QMessageBox.warning(
                    self, "依赖缺失",
                    f"{error}\n\n请在命令行运行以下命令安装:\n"
                    "pip install pyzbar Pillow\n\n"
                    "Windows 用户可能还需要安装 Visual C++ Redistributable"
                )
            else:
                self.log("✅ QR 扫描依赖已就绪")
        except ImportError as e:
            self.log(f"⚠️ 无法加载 totp_extractor 模块: {e}")
            self.btn_select.setEnabled(False)
            self.btn_select_multiple.setEnabled(False)

    def _on_select_image(self):
        """选择单个图片"""
        file_path, _ = QFileDialog.getOpenFileName(
            self,
            "选择 QR 码截图",
            "",
            "图片文件 (*.png *.jpg *.jpeg *.bmp *.gif);;所有文件 (*.*)"
        )

        if file_path:
            self._process_images([file_path])

    def _on_select_multiple_images(self):
        """选择多个图片"""
        file_paths, _ = QFileDialog.getOpenFileNames(
            self,
            "选择 QR 码截图",
            "",
            "图片文件 (*.png *.jpg *.jpeg *.bmp *.gif);;所有文件 (*.*)"
        )

        if file_paths:
            self._process_images(file_paths)

    def _process_images(self, file_paths: List[str]):
        """处理图片文件"""
        try:
            from core.totp_extractor import extract_totp_secrets_from_image

            self.progress_bar.setVisible(True)
            self.progress_bar.setRange(0, len(file_paths))

            all_accounts = []
            all_errors = []

            for i, path in enumerate(file_paths):
                self.progress_bar.setValue(i)
                self.log(f"扫描: {os.path.basename(path)}")

                try:
                    accounts, errors = extract_totp_secrets_from_image(path)
                    all_accounts.extend(accounts)
                    all_errors.extend(errors)

                    if accounts:
                        self.log(f"  ✅ 找到 {len(accounts)} 个账号")
                    if errors:
                        for err in errors:
                            self.log(f"  ⚠️ {err}")

                except Exception as e:
                    self.log(f"  ❌ 处理失败: {e}")

            self.progress_bar.setValue(len(file_paths))
            self.progress_bar.setVisible(False)

            if not all_accounts:
                self.log("❌ 未能从图片中提取任何账号")
                QMessageBox.warning(self, "未找到账号", "未能从选择的图片中提取 TOTP 账号。\n\n请确保图片包含有效的 Google Authenticator 导出 QR 码。")
                return

            self._extracted_accounts = all_accounts
            self.log(f"\n📊 共提取 {len(all_accounts)} 个账号")

            # 匹配数据库账号
            self._match_with_database()

        except ImportError as e:
            self.log(f"❌ 模块导入失败: {e}")
            QMessageBox.critical(self, "错误", f"无法加载 QR 扫描模块:\n{e}")
        except Exception as e:
            self.log(f"❌ 处理失败: {e}")
            QMessageBox.critical(self, "错误", f"处理图片失败:\n{e}")

    def _match_with_database(self):
        """与数据库账号匹配"""
        self.log("\n🔍 开始匹配数据库账号...")

        # 获取所有账号
        db_accounts = DBManager.get_all_accounts()
        db_email_map = {acc["email"].lower(): acc for acc in db_accounts}

        self._match_results = []

        for otp_acc in self._extracted_accounts:
            email = otp_acc.get_email()
            match_result = {
                "otp_account": otp_acc,
                "extracted_email": email,
                "db_account": None,
                "status": "no_match",
            }

            if email and email.lower() in db_email_map:
                db_acc = db_email_map[email.lower()]
                match_result["db_account"] = db_acc

                current_secret = db_acc.get("secret_key", "")
                if current_secret:
                    match_result["status"] = "has_secret"
                else:
                    match_result["status"] = "can_import"

            self._match_results.append(match_result)

        # 统计
        can_import = sum(1 for r in self._match_results if r["status"] == "can_import")
        has_secret = sum(1 for r in self._match_results if r["status"] == "has_secret")
        no_match = sum(1 for r in self._match_results if r["status"] == "no_match")

        self.log(f"  ✅ 可导入: {can_import}")
        self.log(f"  ⚠️ 已有密钥: {has_secret}")
        self.log(f"  ❌ 未匹配: {no_match}")

        self.status_label.setText(f"可导入: {can_import} | 已有密钥: {has_secret} | 未匹配: {no_match}")

        # 更新表格
        self._update_table()

    def _update_table(self):
        """更新表格"""
        self.table.setRowCount(0)

        only_matched = self.chk_only_matched.isChecked()

        for result in self._match_results:
            # 过滤
            if only_matched and result["status"] == "no_match":
                continue

            row = self.table.rowCount()
            self.table.insertRow(row)

            otp_acc = result["otp_account"]
            db_acc = result["db_account"]
            status = result["status"]

            # 选择框
            checkbox = QCheckBox()
            checkbox.setChecked(status == "can_import")
            checkbox.setEnabled(status in ("can_import", "has_secret"))
            checkbox_widget = QWidget()
            checkbox_layout = QHBoxLayout(checkbox_widget)
            checkbox_layout.addWidget(checkbox)
            checkbox_layout.setAlignment(Qt.AlignmentFlag.AlignCenter)
            checkbox_layout.setContentsMargins(0, 0, 0, 0)
            self.table.setCellWidget(row, 0, checkbox_widget)

            # 提取邮箱
            email = result["extracted_email"] or otp_acc.name
            self.table.setItem(row, 1, QTableWidgetItem(email))

            # 发行方
            self.table.setItem(row, 2, QTableWidgetItem(otp_acc.issuer or "-"))

            # 密钥（显示前 16 位）
            secret_display = otp_acc.secret[:16] + "..." if len(otp_acc.secret) > 16 else otp_acc.secret
            secret_item = QTableWidgetItem(secret_display)
            secret_item.setToolTip(otp_acc.secret)
            self.table.setItem(row, 3, secret_item)

            # 匹配账号
            if db_acc:
                self.table.setItem(row, 4, QTableWidgetItem(db_acc["email"]))
            else:
                item = QTableWidgetItem("未匹配")
                item.setForeground(QColor("#888888"))
                self.table.setItem(row, 4, item)

            # 当前密钥
            if db_acc:
                current = db_acc.get("secret_key", "")
                if current:
                    display = current[:8] + "..." if len(current) > 8 else current
                    self.table.setItem(row, 5, QTableWidgetItem(display))
                else:
                    item = QTableWidgetItem("无")
                    item.setForeground(QColor("#888888"))
                    self.table.setItem(row, 5, item)
            else:
                self.table.setItem(row, 5, QTableWidgetItem("-"))

            # 状态
            status_text = {
                "can_import": "✅ 可导入",
                "has_secret": "⚠️ 已有",
                "no_match": "❌ 未匹配",
            }
            status_color = {
                "can_import": QColor("#4CAF50"),
                "has_secret": QColor("#FF9800"),
                "no_match": QColor("#888888"),
            }
            status_item = QTableWidgetItem(status_text.get(status, status))
            status_item.setForeground(status_color.get(status, QColor("#888888")))
            self.table.setItem(row, 6, status_item)

        # 更新按钮状态
        self.btn_import.setEnabled(self.table.rowCount() > 0)

    def _apply_filter(self):
        """应用过滤"""
        self._update_table()

    def _on_select_all(self):
        """全选"""
        for row in range(self.table.rowCount()):
            checkbox_widget = self.table.cellWidget(row, 0)
            if checkbox_widget:
                checkbox = checkbox_widget.findChild(QCheckBox)
                if checkbox and checkbox.isEnabled():
                    checkbox.setChecked(True)

    def _on_deselect_all(self):
        """取消全选"""
        for row in range(self.table.rowCount()):
            checkbox_widget = self.table.cellWidget(row, 0)
            if checkbox_widget:
                checkbox = checkbox_widget.findChild(QCheckBox)
                if checkbox:
                    checkbox.setChecked(False)

    def _refresh_match(self):
        """刷新匹配"""
        if self._extracted_accounts:
            self._match_with_database()

    def _on_import(self):
        """导入选中的账号"""
        selected_results = []

        # 获取当前显示的匹配结果
        only_matched = self.chk_only_matched.isChecked()
        visible_results = [
            r for r in self._match_results
            if not only_matched or r["status"] != "no_match"
        ]

        for row in range(self.table.rowCount()):
            checkbox_widget = self.table.cellWidget(row, 0)
            if checkbox_widget:
                checkbox = checkbox_widget.findChild(QCheckBox)
                if checkbox and checkbox.isChecked() and row < len(visible_results):
                    result = visible_results[row]
                    if result["db_account"]:
                        selected_results.append(result)

        if not selected_results:
            QMessageBox.information(self, "提示", "请选择要导入的账号")
            return

        # 确认导入
        overwrite_count = sum(1 for r in selected_results if r["status"] == "has_secret")
        new_count = len(selected_results) - overwrite_count

        msg = f"即将导入 {len(selected_results)} 个账号的 TOTP 密钥:\n\n"
        msg += f"  • 新增密钥: {new_count} 个\n"
        if overwrite_count > 0:
            msg += f"  • 覆盖已有: {overwrite_count} 个\n"
        msg += "\n确定要继续吗？"

        reply = QMessageBox.question(
            self, "确认导入", msg,
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
        )

        if reply != QMessageBox.StandardButton.Yes:
            return

        # 导入 ixBrowser API（放在循环外）
        try:
            from services.ix_api import update_profile, get_profile_list
            ix_api_available = True
        except ImportError:
            ix_api_available = False

        # 获取所有 ixBrowser 窗口，建立名称到 ID 的映射
        ix_profile_map = {}  # {窗口名称.lower(): profile_id}
        if ix_api_available:
            try:
                self.log("🔍 正在获取 ixBrowser 窗口列表...")
                # 获取所有窗口（分页获取）
                page = 1
                while True:
                    profiles = get_profile_list(page=page, limit=100)
                    if not profiles:
                        break
                    for p in profiles:
                        # p 可能是 dict 或 object
                        if isinstance(p, dict):
                            name = p.get("name", "")
                            pid = p.get("profile_id") or p.get("id")
                        else:
                            name = getattr(p, "name", "")
                            pid = getattr(p, "profile_id", None) or getattr(p, "id", None)
                        if name and pid:
                            ix_profile_map[name.lower()] = pid
                    if len(profiles) < 100:
                        break
                    page += 1
                if ix_profile_map:
                    self.log(f"  ✅ 获取到 {len(ix_profile_map)} 个窗口")
                else:
                    self.log("  ⚠️ 未获取到窗口（请确保 ixBrowser 正在运行）")
            except Exception as e:
                self.log(f"  ⚠️ 获取窗口列表失败: {e}")

        # 执行导入
        success_count = 0
        ix_update_count = 0
        bind_count = 0

        for result in selected_results:
            db_account = result["db_account"]
            email = db_account["email"]
            secret = result["otp_account"].secret

            try:
                # 更新数据库
                DBManager.upsert_account(email, secret_key=secret)
                self.log(f"✅ 已导入: {email}")
                success_count += 1

                # 获取或查找 profile_id
                profile_id = db_account.get("browser_profile_id")

                # 如果没有绑定窗口，尝试通过邮箱名称匹配
                if not profile_id and ix_api_available:
                    matched_pid = ix_profile_map.get(email.lower())
                    if matched_pid:
                        profile_id = matched_pid
                        # 更新数据库绑定
                        try:
                            DBManager.upsert_account(email, browser_profile_id=str(profile_id))
                            self.log(f"  🔗 已自动绑定窗口: {profile_id}")
                            bind_count += 1
                        except Exception as e:
                            self.log(f"  ⚠️ 绑定窗口失败: {e}")

                # 更新 ixBrowser 窗口备注
                if profile_id and ix_api_available:
                    try:
                        # 构建备注格式: email----password----recovery----secret
                        password = db_account.get("password") or ""
                        recovery = db_account.get("recovery_email") or ""
                        note = f"{email}----{password}----{recovery}----{secret}"

                        if update_profile(int(profile_id), note=note):
                            self.log(f"  📝 已更新窗口备注: {profile_id}")
                            ix_update_count += 1
                        else:
                            self.log(f"  ⚠️ 更新窗口备注失败: {profile_id}")
                    except Exception as e:
                        self.log(f"  ⚠️ 更新窗口备注异常: {e}")

            except Exception as e:
                self.log(f"❌ 导入失败 {email}: {e}")

        self.log(f"\n📊 导入完成: 成功 {success_count}/{len(selected_results)}")
        if bind_count > 0:
            self.log(f"🔗 已自动绑定 {bind_count} 个窗口")
        if ix_update_count > 0:
            self.log(f"📝 已更新 {ix_update_count} 个窗口备注")

        QMessageBox.information(
            self, "导入完成",
            f"成功导入 {success_count}/{len(selected_results)} 个账号的 TOTP 密钥\n"
            f"已自动绑定 {bind_count} 个窗口\n"
            f"已更新 {ix_update_count} 个窗口备注"
        )

        # 刷新匹配
        self._refresh_match()

    def log(self, msg: str):
        """添加日志"""
        timestamp = datetime.now().strftime("%H:%M:%S")
        self.log_text.append(f"[{timestamp}] {msg}")

    # ==================== 拖放支持 ====================

    def dragEnterEvent(self, event: QDragEnterEvent):
        """拖入事件"""
        if event.mimeData().hasUrls():
            # 检查是否是图片文件
            for url in event.mimeData().urls():
                if url.isLocalFile():
                    path = url.toLocalFile().lower()
                    if any(path.endswith(ext) for ext in (".png", ".jpg", ".jpeg", ".bmp", ".gif")):
                        event.acceptProposedAction()
                        return
        event.ignore()

    def dropEvent(self, event: QDropEvent):
        """放下事件"""
        file_paths = []
        for url in event.mimeData().urls():
            if url.isLocalFile():
                path = url.toLocalFile()
                if any(path.lower().endswith(ext) for ext in (".png", ".jpg", ".jpeg", ".bmp", ".gif")):
                    file_paths.append(path)

        if file_paths:
            self._process_images(file_paths)


# ==================== 测试代码 ====================

if __name__ == "__main__":
    import sys
    from PyQt6.QtWidgets import QApplication

    # 初始化数据库
    DBManager.init_db()

    app = QApplication(sys.argv)
    dialog = ImportTOTPDialog()
    dialog.show()
    sys.exit(app.exec())
