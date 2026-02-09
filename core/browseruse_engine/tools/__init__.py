"""
BrowserUse Engine - 动作系统模块

提供动作注册、定义和执行功能。
"""

# 导入注册器 (必须先导入)
from .registry import ActionRegistry, ActionSchema

# 导入内置动作 (触发注册)
from . import actions

# 导入执行器
from .executor import ActionExecutor

__all__ = [
    # 注册器
    "ActionRegistry",
    "ActionSchema",
    # 执行器
    "ActionExecutor",
]
