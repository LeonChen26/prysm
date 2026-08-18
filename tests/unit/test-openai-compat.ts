/**
 * OpenAI Compatible 端点（model-router.ts）验证脚本 —— 纯函数断言，无需 LLM。
 * 覆盖：isOpenAICompatConfigured（baseUrl+apiKey 齐全判定）、openaiCompatModels（环境变量解析+默认）。
 * 运行：npx tsx tests/unit/test-openai-compat.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configure, resetConfig } from "../../lib/config";
import {
  isOpenAICompatConfigured,
  openaiCompatModels,
  OPENAI_COMPAT_ENV,
} from "../../lib/model-router";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

function expectEq(name: string, actual: unknown, want: unknown) {
  const ok =
    typeof actual === "object" && typeof want === "object"
      ? JSON.stringify(actual) === JSON.stringify(want)
      : actual === want;
  if (!ok) {
    fail(`${name}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`);
  }
  console.log(`  ✓ ${name} = ${JSON.stringify(actual)}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prysm-openai-compat-"));

console.log("== isOpenAICompatConfigured ==");
{
  // 未配置 env → false
  configure({ baseDir: tmp, env: {} });
  expectEq("无 env → false", isOpenAICompatConfigured(), false);

  // 只有 baseUrl → false
  configure({ baseDir: tmp, env: { [OPENAI_COMPAT_ENV.baseUrl]: "https://api.example.com" } });
  expectEq("仅有 baseUrl → false", isOpenAICompatConfigured(), false);

  // 只有 apiKey → false
  configure({ baseDir: tmp, env: { [OPENAI_COMPAT_ENV.apiKey]: "sk-test" } });
  expectEq("仅有 apiKey → false", isOpenAICompatConfigured(), false);

  // baseUrl + apiKey 都有 → true
  configure({
    baseDir: tmp,
    env: {
      [OPENAI_COMPAT_ENV.baseUrl]: "https://api.example.com",
      [OPENAI_COMPAT_ENV.apiKey]: "sk-test",
    },
  });
  expectEq("baseUrl + apiKey → true", isOpenAICompatConfigured(), true);

  // baseUrl 为空字符串 → false
  configure({
    baseDir: tmp,
    env: {
      [OPENAI_COMPAT_ENV.baseUrl]: "",
      [OPENAI_COMPAT_ENV.apiKey]: "sk-test",
    },
  });
  expectEq("空 baseUrl → false", isOpenAICompatConfigured(), false);
}

console.log("\n== openaiCompatModels ==");
{
  // 未配置 → 默认模型目录
  configure({ baseDir: tmp, env: {} });
  const defaults = openaiCompatModels();
  expectEq("未配置 models → 使用默认目录", defaults, ["gpt-4o-mini"]);

  // 配置单个模型
  configure({ baseDir: tmp, env: { [OPENAI_COMPAT_ENV.models]: "custom-model" } });
  expectEq("单个模型", openaiCompatModels(), ["custom-model"]);

  // 配置多个模型（逗号分隔）
  configure({
    baseDir: tmp,
    env: { [OPENAI_COMPAT_ENV.models]: "model-a,model-b,model-c" },
  });
  expectEq("多个模型逗号分隔", openaiCompatModels(), ["model-a", "model-b", "model-c"]);

  // 含空白字符的模型列表
  configure({
    baseDir: tmp,
    env: { [OPENAI_COMPAT_ENV.models]: " gpt-4 , claude-sonnet , deepseek-chat " },
  });
  expectEq("含空白的逗号分隔", openaiCompatModels(), ["gpt-4", "claude-sonnet", "deepseek-chat"]);

  // 空字符串 → 默认
  configure({ baseDir: tmp, env: { [OPENAI_COMPAT_ENV.models]: "" } });
  expectEq("空字符串 → 默认目录", openaiCompatModels(), ["gpt-4o-mini"]);

  // 只有逗号和空格 → 默认
  configure({ baseDir: tmp, env: { [OPENAI_COMPAT_ENV.models]: " , , " } });
  expectEq("仅逗号空格 → 默认目录", openaiCompatModels(), ["gpt-4o-mini"]);
}

console.log("\n== OPENAI_COMPAT_ENV 常量 ==");
{
  expectEq("baseUrl key", OPENAI_COMPAT_ENV.baseUrl, "OPENAI_COMPAT_BASE_URL");
  expectEq("apiKey key", OPENAI_COMPAT_ENV.apiKey, "OPENAI_COMPAT_API_KEY");
  expectEq("models key", OPENAI_COMPAT_ENV.models, "OPENAI_COMPAT_MODELS");
}

resetConfig();
fs.rmSync(tmp, { recursive: true, force: true });

console.log("\n✓ OpenAI Compatible 端点验证通过");
