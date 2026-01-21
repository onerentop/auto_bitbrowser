"""
综合查询窗口 - 查询账户在各个自动化操作中的状态

功能:
- 综合视图: 单表展示所有账户状态
- 筛选功能: 按状态、修改历史、时间范围、关键词筛选
- 导出功能: 支持导出为 CSV/TXT
"""

import os
import sys
from datetime import datetime, timedelta
from PyQt6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QPushButton, QLabel,
    QLineEdit, QTableWidget, QTableWidgetItem, QHeaderView,
    QMessageBox, QWidget, QAbstractItemView, QComboBox,
    QGroupBox, QDateEdit, QFileDialog, QCheckBox, QSplitter
)
from PyQt6.QtCore import Qt, QDate
from PyQt6.QtGui import QColor, QBrush

from database import DBManager


class ComprehensiveQueryWindow(QDialog):
    """综合查询窗口"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("综合查询 - 账户状态总览")
        self.resize(1400, 800)

        self.all_data = []  # 所有数据
        self.filtered_data = []  # 筛选后的数据

        self.init_ui()
        self.load_data()

    def init_ui(self):
        """初始化界面"""
        main_layout = QHBoxLayout()

        # 左侧: 筛选面板
        filter_panel = self._create_filter_panel()
        filter_panel.setFixedWidth(280)

        # 右侧: 表格和操作按钮
        right_widget = QWidget()
        right_layout = QVBoxLayout(right_widget)
        right_layout.setContentsMargins(0, 0, 0, 0)

        # 表格
        self.table = self._create_table()
        right_layout.addWidget(self.table)

        # 底部统计和操作栏
        bottom_layout = self._create_bottom_bar()
        right_layout.addLayout(bottom_layout)

        main_layout.addWidget(filter_panel)
        main_layout.addWidget(right_widget)

        self.setLayout(main_layout)

    def _create_filter_panel(self) -> QWidget:
        """创建筛选面板"""
        panel = QWidget()
        layout = QVBoxLayout(panel)

        # === 主状态筛选 ===
        status_group = QGroupBox("主状态筛选")
        status_layout = QVBoxLayout()

        self.status_combo = QComboBox()
        self.status_combo.addItems([
            "全部状态",
            "pending - 待处理",
            "link_ready - 链接已获取",
            "verified - 已验证",
            "subscribed - 已订阅",
            "ineligible - 无资格",
            "error - 错误",
            "running - 运行中"
        ])
        status_layout.addWidget(self.status_combo)
        status_group.setLayout(status_layout)
        layout.addWidget(status_group)

        # === 修改历史筛选 ===
        history_group = QGroupBox("修改历史筛选")
        history_layout = QVBoxLayout()

        self.cb_phone_modified = QCheckBox("辅助手机号已修改")
        self.cb_email_modified = QCheckBox("辅助邮箱已修改")
        self.cb_sv2_modified = QCheckBox("2SV手机号已修改")
        self.cb_auth_modified = QCheckBox("验证器已修改")
        self.cb_sheerid_verified = QCheckBox("SheerID已验证")

        history_layout.addWidget(self.cb_phone_modified)
        history_layout.addWidget(self.cb_email_modified)
        history_layout.addWidget(self.cb_sv2_modified)
        history_layout.addWidget(self.cb_auth_modified)
        history_layout.addWidget(self.cb_sheerid_verified)

        history_group.setLayout(history_layout)
        layout.addWidget(history_group)

        # === 时间范围筛选 ===
        time_group = QGroupBox("时间范围筛选")
        time_layout = QVBoxLayout()

        time_layout.addWidget(QLabel("更新时间从:"))
        self.date_from = QDateEdit()
        self.date_from.setCalendarPopup(True)
        self.date_from.setDate(QDate.currentDate().addDays(-30))
        time_layout.addWidget(self.date_from)

        time_layout.addWidget(QLabel("更新时间到:"))
        self.date_to = QDateEdit()
        self.date_to.setCalendarPopup(True)
        self.date_to.setDate(QDate.currentDate())
        time_layout.addWidget(self.date_to)

        self.cb_enable_time_filter = QCheckBox("启用时间筛选")
        time_layout.addWidget(self.cb_enable_time_filter)

        time_group.setLayout(time_layout)
        layout.addWidget(time_group)

        # === 关键词搜索 ===
        search_group = QGroupBox("关键词搜索")
        search_layout = QVBoxLayout()

        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("输入邮箱、手机号等关键词...")
        self.search_input.returnPressed.connect(self.apply_filter)
        search_layout.addWidget(self.search_input)

        search_group.setLayout(search_layout)
        layout.addWidget(search_group)

        # === 操作按钮 ===
        btn_layout = QVBoxLayout()

        self.btn_apply = QPushButton("应用筛选")
        self.btn_apply.setStyleSheet("background-color: #4CAF50; color: white; font-weight: bold; padding: 8px;")
        self.btn_apply.clicked.connect(self.apply_filter)
        btn_layout.addWidget(self.btn_apply)

        self.btn_reset = QPushButton("重置筛选")
        self.btn_reset.clicked.connect(self.reset_filter)
        btn_layout.addWidget(self.btn_reset)

        self.btn_refresh = QPushButton("刷新数据")
        self.btn_refresh.clicked.connect(self.load_data)
        btn_layout.addWidget(self.btn_refresh)

        layout.addLayout(btn_layout)
        layout.addStretch()

        return panel

    def _create_table(self) -> QTableWidget:
        """创建数据表格"""
        table = QTableWidget()

        # 定义列
        columns = [
            "邮箱", "密码", "辅助邮箱", "2FA密钥", "主状态", "更新时间",
            "辅助手机号", "辅助邮箱状态", "2SV手机号", "验证器状态", "SheerID状态"
        ]
        table.setColumnCount(len(columns))
        table.setHorizontalHeaderLabels(columns)

        # 设置列宽
        table.setColumnWidth(0, 200)  # 邮箱
        table.setColumnWidth(1, 100)  # 密码
        table.setColumnWidth(2, 150)  # 辅助邮箱
        table.setColumnWidth(3, 100)  # 2FA密钥
        table.setColumnWidth(4, 80)   # 主状态
        table.setColumnWidth(5, 120)  # 更新时间
        table.setColumnWidth(6, 120)  # 辅助手机号
        table.setColumnWidth(7, 120)  # 辅助邮箱状态
        table.setColumnWidth(8, 120)  # 2SV手机号
        table.setColumnWidth(9, 100)  # 验证器状态
        table.setColumnWidth(10, 100) # SheerID状态

        table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        table.setAlternatingRowColors(True)

        return table

    def _create_bottom_bar(self) -> QHBoxLayout:
        """创建底部操作栏"""
        layout = QHBoxLayout()

        # 统计信息
        self.lbl_stats = QLabel("共 0 条记录, 筛选后 0 条")
        layout.addWidget(self.lbl_stats)

        layout.addStretch()

        # 导出按钮
        self.btn_export_csv = QPushButton("导出 CSV")
        self.btn_export_csv.clicked.connect(lambda: self.export_data("csv"))
        layout.addWidget(self.btn_export_csv)

        self.btn_export_txt = QPushButton("导出 TXT")
        self.btn_export_txt.clicked.connect(lambda: self.export_data("txt"))
        layout.addWidget(self.btn_export_txt)

        return layout

    def load_data(self):
        """加载数据"""
        try:
            DBManager.init_db()
            self.all_data = DBManager.get_comprehensive_account_data()
            self.filtered_data = self.all_data.copy()
            self.update_table()
            self.update_stats()
        except Exception as e:
            QMessageBox.critical(self, "错误", f"加载数据失败: {e}")

    def apply_filter(self):
        """应用筛选条件"""
        self.filtered_data = []

        # 获取筛选条件
        status_text = self.status_combo.currentText()
        status_filter = None
        if status_text != "全部状态":
            status_filter = status_text.split(" - ")[0]

        keyword = self.search_input.text().strip().lower()

        enable_time = self.cb_enable_time_filter.isChecked()
        date_from = self.date_from.date().toPyDate() if enable_time else None
        date_to = self.date_to.date().toPyDate() if enable_time else None

        for row in self.all_data:
            # 状态筛选
            if status_filter and row.get('status') != status_filter:
                continue

            # 修改历史筛选
            if self.cb_phone_modified.isChecked() and not row.get('phone_modified'):
                continue
            if self.cb_email_modified.isChecked() and not row.get('email_modified'):
                continue
            if self.cb_sv2_modified.isChecked() and not row.get('sv2_phone_modified'):
                continue
            if self.cb_auth_modified.isChecked() and not row.get('auth_modified'):
                continue
            if self.cb_sheerid_verified.isChecked() and not row.get('sheerid_verified'):
                continue

            # 时间筛选
            if enable_time and row.get('updated_at'):
                try:
                    updated_str = str(row['updated_at'])
                    if 'T' in updated_str or '+' in updated_str:
                        updated = datetime.fromisoformat(updated_str.replace('Z', '+00:00'))
                    else:
                        # SQLite 默认格式
                        updated = datetime.strptime(updated_str[:19], '%Y-%m-%d %H:%M:%S')
                    updated_date = updated.date()
                    if date_from and updated_date < date_from:
                        continue
                    if date_to and updated_date > date_to:
                        continue
                except:
                    pass

            # 关键词搜索
            if keyword:
                searchable = " ".join([
                    str(row.get('email', '')),
                    str(row.get('recovery_email', '')),
                    str(row.get('phone_new', '')),
                    str(row.get('email_new', '')),
                    str(row.get('sv2_phone_new', '')),
                    str(row.get('message', ''))
                ]).lower()
                if keyword not in searchable:
                    continue

            self.filtered_data.append(row)

        self.update_table()
        self.update_stats()

    def reset_filter(self):
        """重置筛选条件"""
        self.status_combo.setCurrentIndex(0)
        self.cb_phone_modified.setChecked(False)
        self.cb_email_modified.setChecked(False)
        self.cb_sv2_modified.setChecked(False)
        self.cb_auth_modified.setChecked(False)
        self.cb_sheerid_verified.setChecked(False)
        self.cb_enable_time_filter.setChecked(False)
        self.search_input.clear()

        self.filtered_data = self.all_data.copy()
        self.update_table()
        self.update_stats()

    def update_table(self):
        """更新表格显示"""
        self.table.setRowCount(0)
        self.table.setRowCount(len(self.filtered_data))

        for row_idx, data in enumerate(self.filtered_data):
            # 邮箱
            self.table.setItem(row_idx, 0, QTableWidgetItem(data.get('email', '')))

            # 密码 (显示前4位 + ***)
            pwd = data.get('password', '') or ''
            masked_pwd = pwd[:4] + '***' if pwd and len(pwd) > 4 else pwd
            self.table.setItem(row_idx, 1, QTableWidgetItem(masked_pwd))

            # 辅助邮箱
            self.table.setItem(row_idx, 2, QTableWidgetItem(data.get('recovery_email', '') or ''))

            # 2FA密钥 (显示前8位 + ...)
            secret = data.get('secret_key', '') or ''
            masked_secret = secret[:8] + '...' if len(secret) > 8 else secret
            self.table.setItem(row_idx, 3, QTableWidgetItem(masked_secret))

            # 主状态
            status = data.get('status', '')
            status_item = QTableWidgetItem(status)
            status_item.setBackground(self._get_status_color(status))
            self.table.setItem(row_idx, 4, status_item)

            # 更新时间
            updated_at = data.get('updated_at', '')
            if updated_at:
                try:
                    # 尝试多种时间格式解析
                    updated_str = str(updated_at)
                    if 'T' in updated_str or '+' in updated_str:
                        dt = datetime.fromisoformat(updated_str.replace('Z', '+00:00'))
                    else:
                        # SQLite 默认格式: YYYY-MM-DD HH:MM:SS
                        dt = datetime.strptime(updated_str[:19], '%Y-%m-%d %H:%M:%S')
                    updated_at = dt.strftime('%Y-%m-%d %H:%M')
                except:
                    pass
            self.table.setItem(row_idx, 5, QTableWidgetItem(str(updated_at) if updated_at else ''))

            # 辅助手机号状态
            phone_status = self._format_modification_status(
                data.get('phone_modified'),
                data.get('phone_new'),
                data.get('phone_modified_at')
            )
            self.table.setItem(row_idx, 6, QTableWidgetItem(phone_status))

            # 辅助邮箱修改状态
            email_mod_status = self._format_modification_status(
                data.get('email_modified'),
                data.get('email_new'),
                data.get('email_modified_at')
            )
            self.table.setItem(row_idx, 7, QTableWidgetItem(email_mod_status))

            # 2SV手机号状态
            sv2_status = self._format_modification_status(
                data.get('sv2_phone_modified'),
                data.get('sv2_phone_new'),
                data.get('sv2_phone_modified_at')
            )
            self.table.setItem(row_idx, 8, QTableWidgetItem(sv2_status))

            # 验证器状态
            auth_status = "✅ 已修改" if data.get('auth_modified') else "—"
            self.table.setItem(row_idx, 9, QTableWidgetItem(auth_status))

            # SheerID状态
            sheerid_result = data.get('sheerid_result', '')
            if sheerid_result == 'success':
                sheerid_status = "✅ 成功"
            elif sheerid_result == 'error':
                sheerid_status = "❌ 失败"
            elif sheerid_result:
                sheerid_status = f"⏳ {sheerid_result}"
            else:
                sheerid_status = "—"
            self.table.setItem(row_idx, 10, QTableWidgetItem(sheerid_status))

    def _get_status_color(self, status: str) -> QBrush:
        """根据状态返回背景颜色"""
        colors = {
            'pending': QColor(255, 255, 200),      # 浅黄
            'link_ready': QColor(200, 220, 255),   # 浅蓝
            'verified': QColor(200, 255, 200),     # 浅绿
            'subscribed': QColor(150, 255, 150),   # 绿色
            'ineligible': QColor(255, 200, 200),   # 浅红
            'error': QColor(255, 150, 150),        # 红色
            'running': QColor(220, 220, 255),      # 淡紫
        }
        return QBrush(colors.get(status, QColor(255, 255, 255)))

    def _format_modification_status(self, modified: bool, new_value: str, modified_at: str) -> str:
        """格式化修改状态显示"""
        if not modified:
            return "—"
        if new_value:
            return f"→ {new_value}"
        return "✅ 已修改"

    def update_stats(self):
        """更新统计信息"""
        total = len(self.all_data)
        filtered = len(self.filtered_data)
        self.lbl_stats.setText(f"共 {total} 条记录, 筛选后 {filtered} 条")

    def export_data(self, format_type: str):
        """导出数据"""
        if not self.filtered_data:
            QMessageBox.warning(self, "提示", "没有数据可导出")
            return

        # 选择保存路径
        if format_type == "csv":
            file_path, _ = QFileDialog.getSaveFileName(
                self, "导出 CSV", "account_query_result.csv", "CSV Files (*.csv)"
            )
        else:
            file_path, _ = QFileDialog.getSaveFileName(
                self, "导出 TXT", "account_query_result.txt", "Text Files (*.txt)"
            )

        if not file_path:
            return

        try:
            with open(file_path, 'w', encoding='utf-8-sig' if format_type == 'csv' else 'utf-8') as f:
                if format_type == "csv":
                    # CSV 格式
                    headers = [
                        "邮箱", "密码", "辅助邮箱", "2FA密钥", "主状态", "更新时间",
                        "辅助手机号已修改", "新辅助手机号", "辅助邮箱已修改", "新辅助邮箱",
                        "2SV手机号已修改", "新2SV手机号", "验证器已修改", "SheerID结果"
                    ]
                    f.write(",".join(headers) + "\n")

                    for row in self.filtered_data:
                        values = [
                            row.get('email', ''),
                            row.get('password', ''),
                            row.get('recovery_email', '') or '',
                            row.get('secret_key', '') or '',
                            row.get('status', ''),
                            str(row.get('updated_at', '')),
                            "是" if row.get('phone_modified') else "否",
                            row.get('phone_new', '') or '',
                            "是" if row.get('email_modified') else "否",
                            row.get('email_new', '') or '',
                            "是" if row.get('sv2_phone_modified') else "否",
                            row.get('sv2_phone_new', '') or '',
                            "是" if row.get('auth_modified') else "否",
                            row.get('sheerid_result', '') or ''
                        ]
                        # 转义逗号和双引号 (CSV标准: 双引号需要转义为两个双引号)
                        escaped = []
                        for v in values:
                            s = str(v) if v is not None else ''
                            if ',' in s or '"' in s or '\n' in s:
                                s = '"' + s.replace('"', '""') + '"'
                            escaped.append(s)
                        f.write(",".join(escaped) + "\n")
                else:
                    # TXT 格式 (账号格式: email----password----recovery----secret)
                    for row in self.filtered_data:
                        parts = [
                            row.get('email', ''),
                            row.get('password', ''),
                            row.get('recovery_email', '') or '',
                            row.get('secret_key', '') or ''
                        ]
                        # 移除末尾空字段
                        while parts and not parts[-1]:
                            parts.pop()
                        f.write("----".join(parts) + "\n")

            QMessageBox.information(self, "成功", f"数据已导出到:\n{file_path}")

        except Exception as e:
            QMessageBox.critical(self, "错误", f"导出失败: {e}")


# 测试入口
if __name__ == "__main__":
    from PyQt6.QtWidgets import QApplication

    app = QApplication(sys.argv)
    window = ComprehensiveQueryWindow()
    window.show()
    sys.exit(app.exec())
