#!/usr/bin/env python3
"""
ixBrowser Automation Tool - 主入口
启动 PyQt-Fluent-Widgets 现代化 GUI 主窗口
"""
import sys
import os

# 确保项目根目录在 Python 路径中
project_root = os.path.dirname(os.path.abspath(__file__))
if project_root not in sys.path:
    sys.path.insert(0, project_root)


def main():
    """主入口函数"""
    from gui.main_window_fluent import run_fluent_app
    run_fluent_app()


def main_legacy():
    """旧版 GUI 入口 (保留用于回退)"""
    from gui.main_window import main as legacy_main
    legacy_main()


if __name__ == "__main__":
    # 检查命令行参数，支持 --legacy 回退到旧版
    if len(sys.argv) > 1 and sys.argv[1] == "--legacy":
        print("[Info] 使用旧版 GUI...")
        main_legacy()
    else:
        main()
