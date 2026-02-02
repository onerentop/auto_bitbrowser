"""
LLM 提供商兼容性测试

测试多 LLM 提供商（Gemini、Anthropic/Claude）的连接和基本功能
支持测试第三方 Claude API 服务（OpenRouter、Together 等）

使用方法:
    # 测试所有配置的提供商
    python tests/test_llm_providers.py

    # 测试特定提供商
    python tests/test_llm_providers.py --provider gemini
    python tests/test_llm_providers.py --provider anthropic

    # 使用自定义配置测试第三方服务
    python tests/test_llm_providers.py --provider anthropic \
        --api-key "your-api-key" \
        --base-url "https://openrouter.ai/api/v1" \
        --model "anthropic/claude-3.5-sonnet"

    # 测试视觉分析（使用测试图片）
    python tests/test_llm_providers.py --provider gemini --test-vision
"""

import os
import sys
import argparse
import asyncio
import time
from pathlib import Path

# 修复 Windows 控制台编码问题
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# 添加项目根目录到路径
sys.path.insert(0, str(Path(__file__).parent.parent))

from core.config_manager import ConfigManager


def test_llm_import():
    """测试 LLM 抽象层导入"""
    print("\n" + "=" * 60)
    print("📦 测试 LLM 抽象层导入")
    print("=" * 60)

    try:
        from core.ai_browser_agent import (
            LLM_ABSTRACTION_AVAILABLE,
            BaseLLM,
            LLMResponse,
            GeminiLLM,
            AnthropicLLM,
            create_llm,
            get_available_providers,
        )

        print(f"✅ LLM 抽象层可用: {LLM_ABSTRACTION_AVAILABLE}")

        if LLM_ABSTRACTION_AVAILABLE:
            print(f"✅ BaseLLM Protocol 已导入")
            print(f"✅ LLMResponse 已导入")
            print(f"✅ GeminiLLM 已导入")
            print(f"✅ AnthropicLLM 已导入")
            print(f"✅ create_llm 工厂函数已导入")

            providers = get_available_providers()
            print(f"✅ 可用提供商: {providers}")

            return True
        else:
            print("❌ LLM 抽象层不可用")
            return False

    except ImportError as e:
        print(f"❌ 导入失败: {e}")
        return False


def test_provider_connection(
    provider: str,
    api_key: str = None,
    base_url: str = None,
    model: str = None,
) -> tuple[bool, str, dict]:
    """
    测试指定提供商的连接

    Args:
        provider: 提供商名称 (gemini, anthropic)
        api_key: API Key (可选，默认从配置读取)
        base_url: Base URL (可选，用于第三方服务)
        model: 模型名称 (可选)

    Returns:
        (success, message, details)
    """
    print(f"\n" + "=" * 60)
    print(f"🔗 测试 {provider.upper()} 连接")
    print("=" * 60)

    try:
        from core.ai_browser_agent import create_llm, LLM_ABSTRACTION_AVAILABLE

        if not LLM_ABSTRACTION_AVAILABLE:
            return False, "LLM 抽象层不可用", {}

        # 获取配置
        if not api_key:
            api_key = ConfigManager.get_ai_provider_api_key(provider)

        if not api_key:
            # 尝试从环境变量读取
            env_key = f"{provider.upper()}_API_KEY"
            api_key = os.environ.get(env_key, "")

        if not api_key:
            return False, f"未配置 {provider.upper()} API Key", {"provider": provider}

        if not base_url:
            base_url = ConfigManager.get_ai_provider_base_url(provider) or None

        if not model:
            model = ConfigManager.get_ai_provider_model(provider) or None

        print(f"  提供商: {provider}")
        print(f"  API Key: {api_key[:8]}...{api_key[-4:] if len(api_key) > 12 else '****'}")
        print(f"  Base URL: {base_url or '(默认)'}")
        print(f"  模型: {model or '(默认)'}")

        # 创建 LLM 实例
        llm = create_llm(
            provider=provider,
            api_key=api_key,
            base_url=base_url,
            model=model,
        )

        print(f"\n  创建 LLM 实例: {llm.provider}/{llm.model}")

        # 测试连接
        print("  正在测试连接...")
        start_time = time.time()
        success, message, details = llm.test_connection()
        elapsed = time.time() - start_time

        details["provider"] = provider
        details["elapsed_time"] = f"{elapsed:.2f}s"

        if success:
            print(f"\n  ✅ 连接成功!")
            print(f"  响应时间: {details.get('response_time_ms', 0)}ms")
            if details.get("response_preview"):
                print(f"  AI 回复: {details['response_preview'][:80]}...")
            if details.get("usage"):
                usage = details["usage"]
                print(f"  Token 使用: 输入 {usage.get('input_tokens', 0)}, 输出 {usage.get('output_tokens', 0)}")
        else:
            print(f"\n  ❌ 连接失败: {message}")
            if details.get("error_type"):
                print(f"  错误类型: {details['error_type']}")
            if details.get("error_detail"):
                print(f"  错误详情: {details['error_detail'][:200]}")

        return success, message, details

    except Exception as e:
        import traceback
        traceback.print_exc()
        return False, f"测试异常: {str(e)}", {"error": str(e)}


async def test_vision_analysis(
    provider: str,
    api_key: str = None,
    base_url: str = None,
    model: str = None,
    image_path: str = None,
) -> tuple[bool, str, dict]:
    """
    测试视觉分析功能

    Args:
        provider: 提供商名称
        api_key: API Key
        base_url: Base URL
        model: 模型名称
        image_path: 测试图片路径 (可选)

    Returns:
        (success, message, details)
    """
    print(f"\n" + "=" * 60)
    print(f"👁️ 测试 {provider.upper()} 视觉分析")
    print("=" * 60)

    try:
        from core.ai_browser_agent import create_llm, LLM_ABSTRACTION_AVAILABLE

        if not LLM_ABSTRACTION_AVAILABLE:
            return False, "LLM 抽象层不可用", {}

        # 获取配置
        if not api_key:
            api_key = ConfigManager.get_ai_provider_api_key(provider)

        if not api_key:
            env_key = f"{provider.upper()}_API_KEY"
            api_key = os.environ.get(env_key, "")

        if not api_key:
            return False, f"未配置 {provider.upper()} API Key", {"provider": provider}

        if not base_url:
            base_url = ConfigManager.get_ai_provider_base_url(provider) or None

        if not model:
            model = ConfigManager.get_ai_provider_model(provider) or None

        # 创建 LLM 实例
        llm = create_llm(
            provider=provider,
            api_key=api_key,
            base_url=base_url,
            model=model,
        )

        print(f"  创建 LLM 实例: {llm.provider}/{llm.model}")

        # 准备测试图片
        if image_path and os.path.exists(image_path):
            with open(image_path, "rb") as f:
                screenshot = f.read()
            print(f"  使用测试图片: {image_path}")
        else:
            # 创建简单的测试图片 (1x1 红色 PNG)
            # PNG 文件头 + IHDR + IDAT + IEND
            screenshot = bytes([
                0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,  # PNG signature
                0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,  # IHDR chunk
                0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,  # 1x1 image
                0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,  # RGB, etc
                0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,  # IDAT chunk
                0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
                0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x18, 0xDD,
                0x8D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,  # IEND chunk
                0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
            ])
            print("  使用生成的测试图片 (1x1 PNG)")

        print(f"  图片大小: {len(screenshot)} bytes")

        # 测试视觉分析
        print("  正在进行视觉分析...")
        start_time = time.time()

        response = await llm.analyze_screenshot(
            screenshot=screenshot,
            prompt="请简要描述你在这张图片中看到了什么。用一句话回答。",
            system_prompt="你是一个图片分析助手。",
            max_tokens=100,
        )

        elapsed = time.time() - start_time

        details = {
            "provider": provider,
            "model": llm.model,
            "elapsed_time": f"{elapsed:.2f}s",
            "response_time_ms": int(elapsed * 1000),
        }

        if response.content:
            print(f"\n  ✅ 视觉分析成功!")
            print(f"  响应时间: {details['response_time_ms']}ms")
            print(f"  AI 回复: {response.content[:200]}")
            if response.input_tokens or response.output_tokens:
                print(f"  Token 使用: 输入 {response.input_tokens}, 输出 {response.output_tokens}")
                details["usage"] = {
                    "input_tokens": response.input_tokens,
                    "output_tokens": response.output_tokens,
                }
            details["response_preview"] = response.content[:200]
            return True, "视觉分析成功", details
        else:
            print(f"\n  ❌ 视觉分析失败: 响应为空")
            details["finish_reason"] = response.finish_reason
            return False, "响应为空", details

    except Exception as e:
        import traceback
        traceback.print_exc()
        return False, f"视觉分析异常: {str(e)}", {"error": str(e)}


def test_third_party_services():
    """
    测试已知的第三方 Claude API 服务配置

    列出常见的第三方服务及其配置方式
    """
    print("\n" + "=" * 60)
    print("📋 第三方 Claude API 服务配置指南")
    print("=" * 60)

    services = [
        {
            "name": "OpenRouter",
            "base_url": "https://openrouter.ai/api/v1",
            "models": [
                "anthropic/claude-3.5-sonnet",
                "anthropic/claude-3-opus",
                "anthropic/claude-3-haiku",
            ],
            "notes": "需要在 OpenRouter 注册获取 API Key",
        },
        {
            "name": "Together AI",
            "base_url": "https://api.together.xyz/v1",
            "models": [
                "claude-3-sonnet-20240229",
            ],
            "notes": "部分 Claude 模型可用",
        },
        {
            "name": "AWS Bedrock (通过代理)",
            "base_url": "自定义代理 URL",
            "models": [
                "anthropic.claude-3-sonnet-20240229-v1:0",
                "anthropic.claude-3-haiku-20240307-v1:0",
            ],
            "notes": "需要自建代理服务转换 API 格式",
        },
        {
            "name": "自建代理/中转服务",
            "base_url": "自定义 URL",
            "models": ["取决于代理配置"],
            "notes": "支持任何兼容 Anthropic API 格式的服务",
        },
    ]

    for i, service in enumerate(services, 1):
        print(f"\n  {i}. {service['name']}")
        print(f"     Base URL: {service['base_url']}")
        print(f"     可用模型: {', '.join(service['models'][:2])}...")
        print(f"     备注: {service['notes']}")

    print("\n  使用示例:")
    print("  -" * 30)
    print("""
    from core.ai_browser_agent import create_llm

    # OpenRouter 示例
    llm = create_llm(
        provider="anthropic",
        api_key="your-openrouter-api-key",
        base_url="https://openrouter.ai/api/v1",
        model="anthropic/claude-3.5-sonnet",
    )

    # GUI 配置方法:
    # 1. 打开配置管理 -> 全局设置 -> AI Agent 配置
    # 2. 切换到 Anthropic/Claude 标签页
    # 3. 填入第三方服务的 API Key
    # 4. 填入 Base URL (如 https://openrouter.ai/api/v1)
    # 5. 选择或输入模型名称
    # 6. 点击 "测试 Anthropic 连接" 验证
    """)


def run_all_tests(args):
    """运行所有测试"""
    print("\n" + "=" * 60)
    print("🧪 LLM 提供商兼容性测试")
    print("=" * 60)

    results = []

    # 1. 测试导入
    import_ok = test_llm_import()
    results.append(("导入测试", import_ok))

    if not import_ok:
        print("\n❌ 导入测试失败，跳过后续测试")
        return results

    # 2. 测试指定提供商或所有提供商
    providers_to_test = []

    if args.provider:
        providers_to_test = [args.provider]
    else:
        # 测试所有已配置的提供商
        from core.ai_browser_agent import get_available_providers
        providers_to_test = get_available_providers()

    for provider in providers_to_test:
        success, message, details = test_provider_connection(
            provider=provider,
            api_key=args.api_key,
            base_url=args.base_url,
            model=args.model,
        )
        results.append((f"{provider} 连接", success))

        # 视觉分析测试
        if args.test_vision and success:
            vision_success, vision_msg, vision_details = asyncio.run(
                test_vision_analysis(
                    provider=provider,
                    api_key=args.api_key,
                    base_url=args.base_url,
                    model=args.model,
                    image_path=args.image,
                )
            )
            results.append((f"{provider} 视觉分析", vision_success))

    # 3. 显示第三方服务配置指南
    if args.show_guide:
        test_third_party_services()

    # 汇总结果
    print("\n" + "=" * 60)
    print("📊 测试结果汇总")
    print("=" * 60)

    passed = sum(1 for _, ok in results if ok)
    total = len(results)

    for name, ok in results:
        status = "✅" if ok else "❌"
        print(f"  {status} {name}")

    print(f"\n  总计: {passed}/{total} 通过")

    return results


def main():
    parser = argparse.ArgumentParser(
        description="LLM 提供商兼容性测试",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 测试所有配置的提供商
  python tests/test_llm_providers.py

  # 测试 Gemini
  python tests/test_llm_providers.py --provider gemini

  # 测试第三方 Claude API (OpenRouter)
  python tests/test_llm_providers.py --provider anthropic \\
      --api-key "sk-or-xxx" \\
      --base-url "https://openrouter.ai/api/v1" \\
      --model "anthropic/claude-3.5-sonnet"

  # 包含视觉分析测试
  python tests/test_llm_providers.py --provider gemini --test-vision

  # 显示第三方服务配置指南
  python tests/test_llm_providers.py --show-guide
        """
    )

    parser.add_argument(
        "--provider",
        choices=["gemini", "anthropic"],
        help="指定要测试的提供商 (默认测试所有已配置的)",
    )

    parser.add_argument(
        "--api-key",
        help="API Key (默认从配置文件读取)",
    )

    parser.add_argument(
        "--base-url",
        help="Base URL (用于第三方服务)",
    )

    parser.add_argument(
        "--model",
        help="模型名称",
    )

    parser.add_argument(
        "--test-vision",
        action="store_true",
        help="测试视觉分析功能",
    )

    parser.add_argument(
        "--image",
        help="视觉测试使用的图片路径",
    )

    parser.add_argument(
        "--show-guide",
        action="store_true",
        help="显示第三方服务配置指南",
    )

    args = parser.parse_args()

    # 加载配置
    ConfigManager.load()

    # 运行测试
    results = run_all_tests(args)

    # 返回退出码
    all_passed = all(ok for _, ok in results)
    sys.exit(0 if all_passed else 1)


if __name__ == "__main__":
    main()
