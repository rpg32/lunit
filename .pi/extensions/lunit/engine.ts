import { parse as parseYaml } from "yaml";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve, dirname, extname } from "node:path";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  AuthStorage,
  ModelRegistry,
  createReadTool,
  createBashTool,
  createEditTool,
  createWriteTool,
  createGrepTool,
  createFindTool,
  createLsTool,
  type Skill,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type {
  LUnitConfig,
  TestDefinition,
  TestAssertion,
  TestResult,
  CapturedToolCall,
  AssertionResult,
  MockTool,
  MockToolResponse,
} from "./types.ts";

// ─── Model Resolution ─────────────────────────────────────────────────────

export function parseModelString(modelStr: string): { provider: string; modelId: string } {
  const idx = modelStr.indexOf("/");
  if (idx === -1) {
    throw new Error(`Invalid model format: "${modelStr}". Expected: provider/model-id (e.g. "ollama/qwen2.5-coder:14b")`);
  }
  return { provider: modelStr.substring(0, idx), modelId: modelStr.substring(idx + 1) };
}

async function resolveModel(modelStr: string) {
  const { provider, modelId } = parseModelString(modelStr);
  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);

  // 1. Try built-in models (anthropic, openai, google, etc.)
  let model = getModel(provider, modelId) as any;
  if (model) return { model, authStorage, modelRegistry };

  // 2. Try custom models from models.json
  model = modelRegistry.find(provider, modelId);
  if (model) return { model, authStorage, modelRegistry };

  // 3. Try dynamically available models (discovers Ollama, etc.)
  try {
    const available = await modelRegistry.getAvailable();
    // Match by provider and id
    model = available.find((m: any) => {
      const mProvider = m.provider?.id ?? m.provider ?? "";
      const mId = m.id ?? "";
      return mProvider === provider && mId === modelId;
    });
    if (model) return { model, authStorage, modelRegistry };
  } catch {
    // getAvailable might fail if providers are unreachable
  }

  throw new Error(
    `Model not found: "${modelStr}". Make sure the model is installed (e.g. 'ollama pull ${modelId}') and the provider is available.`
  );
}

// ─── Config Loading ───────────────────────────────────────────────────────

export async function loadConfig(cwd: string): Promise<LUnitConfig> {
  const defaults: LUnitConfig = {
    default_model: "ollama/qwen2.5-coder:14b",
    test_dir: ".lunit/tests",
    results_dir: ".lunit/results",
    timeout: 120000,
  };
  try {
    const content = await readFile(join(cwd, ".lunit", "config.yml"), "utf-8");
    const parsed = parseYaml(content) as any;
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

// ─── Test File Parsing ────────────────────────────────────────────────────

export async function parseTestFile(filePath: string): Promise<TestDefinition> {
  const content = await readFile(filePath, "utf-8");
  const ext = extname(filePath).toLowerCase();
  if (ext === ".json") return JSON.parse(content) as TestDefinition;
  return parseYaml(content) as TestDefinition;
}

export async function discoverTests(
  testDir: string,
  filter?: { suite?: string; name?: string; tag?: string }
): Promise<{ path: string; test: TestDefinition; parseError?: string }[]> {
  const results: { path: string; test: TestDefinition; parseError?: string }[] = [];

  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (/\.test\.(ya?ml|json)$/.test(entry.name)) {
        try {
          const test = await parseTestFile(fullPath);
          if (matchesFilter(test, filter)) {
            results.push({ path: fullPath, test });
          }
        } catch (e: any) {
          results.push({
            path: fullPath,
            test: { name: `PARSE ERROR: ${entry.name}`, prompt: "", assertions: [] },
            parseError: e.message,
          });
        }
      }
    }
  }

  await walk(testDir);
  return results;
}

function matchesFilter(
  test: TestDefinition,
  filter?: { suite?: string; name?: string; tag?: string }
): boolean {
  if (!filter) return true;
  if (filter.suite && test.suite !== filter.suite) return false;
  if (filter.name && !test.name.toLowerCase().includes(filter.name.toLowerCase())) return false;
  if (filter.tag && !(test.tags ?? []).includes(filter.tag)) return false;
  return true;
}

// ─── Built-in Tool Resolution ─────────────────────────────────────────────

const TOOL_FACTORIES: Record<string, (cwd: string) => any> = {
  read: createReadTool,
  bash: createBashTool,
  edit: createEditTool,
  write: createWriteTool,
  grep: createGrepTool,
  find: createFindTool,
  ls: createLsTool,
};

function resolveBuiltinTools(toolNames: string[], cwd: string): any[] {
  const tools: any[] = [];
  for (const name of toolNames) {
    const factory = TOOL_FACTORIES[name];
    if (factory) {
      tools.push(factory(cwd));
    } else {
      console.warn(`[lunit] Unknown built-in tool: "${name}". Available: ${Object.keys(TOOL_FACTORIES).join(", ")}`);
    }
  }
  return tools;
}

// ─── Mock Tool Builder ────────────────────────────────────────────────────

function buildMockParamSchema(
  params?: Record<string, string | { type: string; description?: string }>
) {
  if (!params || Object.keys(params).length === 0) {
    return Type.Object({});
  }

  const props: Record<string, any> = {};
  for (const [key, spec] of Object.entries(params)) {
    const typeName = typeof spec === "string" ? spec : spec.type;
    const desc = typeof spec === "string" ? undefined : spec.description;
    const opts = desc ? { description: desc } : {};

    switch (typeName) {
      case "number":
        props[key] = Type.Number(opts);
        break;
      case "boolean":
        props[key] = Type.Boolean(opts);
        break;
      case "array":
        props[key] = Type.Array(Type.Unknown(), opts);
        break;
      default:
        props[key] = Type.String(opts);
        break;
    }
  }

  return Type.Object(props);
}

function paramsMatch(actual: Record<string, any>, expected: Record<string, any>): boolean {
  for (const [key, value] of Object.entries(expected)) {
    if (JSON.stringify(actual[key]) !== JSON.stringify(value)) {
      // Also try loose string comparison for numbers/booleans
      if (String(actual[key]) !== String(value)) {
        return false;
      }
    }
  }
  return true;
}

function buildMockTools(mocks: MockTool[]): any[] {
  return mocks.map((mock) => ({
    name: mock.tool,
    label: `[Mock] ${mock.tool}`,
    description: mock.description,
    parameters: buildMockParamSchema(mock.parameters),

    execute: async (_toolCallId: string, params: Record<string, any>) => {
      // Simple error mode
      if (mock.error) {
        throw new Error(mock.error);
      }

      // Simple response mode
      if (mock.response !== undefined) {
        return {
          content: [{ type: "text" as const, text: mock.response }],
          details: { mocked: true },
        };
      }

      // Advanced: conditional responses
      if (mock.responses) {
        // First pass: check explicit match conditions
        for (const r of mock.responses) {
          if (r.match && paramsMatch(params, r.match)) {
            const text = r.return ?? r.default ?? "";
            if (r.is_error) throw new Error(text);
            return {
              content: [{ type: "text" as const, text }],
              details: { mocked: true, matched: r.match },
            };
          }
        }

        // Second pass: find default response (no match condition)
        for (const r of mock.responses) {
          if (!r.match && (r.default !== undefined || r.return !== undefined)) {
            const text = r.default ?? r.return ?? "";
            if (r.is_error) throw new Error(text);
            return {
              content: [{ type: "text" as const, text }],
              details: { mocked: true, default: true },
            };
          }
        }
      }

      // Fallback: no response configured
      return {
        content: [{ type: "text" as const, text: "(mock: no response configured)" }],
        details: { mocked: true, unmatched: true },
      };
    },
  }));
}

// ─── Assertion Evaluators ─────────────────────────────────────────────────

function evaluateToolCalled(
  assertion: Extract<TestAssertion, { type: "tool_called" }>,
  toolCalls: CapturedToolCall[]
): AssertionResult {
  const call = toolCalls.find((tc) => tc.name === assertion.tool);
  if (!call) {
    return {
      type: "tool_called",
      passed: false,
      expected: { tool: assertion.tool },
      actual: { tools_called: toolCalls.map((tc) => tc.name) },
      message: `Tool '${assertion.tool}' was not called. Called: ${toolCalls.map((tc) => tc.name).join(", ") || "none"}`,
    };
  }
  if (assertion.params_contain) {
    for (const [key, value] of Object.entries(assertion.params_contain)) {
      const actual = call.params[key];
      if (JSON.stringify(actual) !== JSON.stringify(value)) {
        return {
          type: "tool_called",
          passed: false,
          expected: { tool: assertion.tool, params: assertion.params_contain },
          actual: { tool: call.name, params: call.params },
          message: `Tool '${assertion.tool}' called but param '${key}' = ${JSON.stringify(actual)}, expected ${JSON.stringify(value)}`,
        };
      }
    }
  }
  return {
    type: "tool_called",
    passed: true,
    expected: { tool: assertion.tool },
    actual: { tool: call.name, params: call.params },
  };
}

function evaluateToolNotCalled(
  assertion: Extract<TestAssertion, { type: "tool_not_called" }>,
  toolCalls: CapturedToolCall[]
): AssertionResult {
  const called = toolCalls.some((tc) => tc.name === assertion.tool);
  return {
    type: "tool_not_called",
    passed: !called,
    expected: { tool_not_called: assertion.tool },
    actual: { was_called: called },
    message: called ? `Tool '${assertion.tool}' was called but should not have been` : undefined,
  };
}

function evaluateOutputContains(
  assertion: Extract<TestAssertion, { type: "output_contains" }>,
  output: string
): AssertionResult {
  const cs = assertion.case_sensitive !== false;
  const found = cs
    ? output.includes(assertion.text)
    : output.toLowerCase().includes(assertion.text.toLowerCase());
  return {
    type: "output_contains",
    passed: found,
    expected: assertion.text,
    actual: found ? "(found)" : output.substring(0, 300),
    message: found ? undefined : `Output does not contain: "${assertion.text}"`,
  };
}

function evaluateOutputNotContains(
  assertion: Extract<TestAssertion, { type: "output_not_contains" }>,
  output: string
): AssertionResult {
  const cs = assertion.case_sensitive !== false;
  const found = cs
    ? output.includes(assertion.text)
    : output.toLowerCase().includes(assertion.text.toLowerCase());
  return {
    type: "output_not_contains",
    passed: !found,
    expected: `not: "${assertion.text}"`,
    actual: found ? "(found — should be absent)" : "(absent)",
    message: found ? `Output contains forbidden text: "${assertion.text}"` : undefined,
  };
}

function evaluateOutputMatches(
  assertion: Extract<TestAssertion, { type: "output_matches" }>,
  output: string
): AssertionResult {
  const regex = new RegExp(assertion.pattern, assertion.flags ?? "i");
  const matched = regex.test(output);
  return {
    type: "output_matches",
    passed: matched,
    expected: `/${assertion.pattern}/${assertion.flags ?? "i"}`,
    actual: matched ? "(matched)" : output.substring(0, 300),
    message: matched ? undefined : `Output does not match pattern: /${assertion.pattern}/${assertion.flags ?? "i"}`,
  };
}

function evaluateNoError(toolCalls: CapturedToolCall[]): AssertionResult {
  const errors = toolCalls.filter((tc) => tc.isError);
  return {
    type: "no_error",
    passed: errors.length === 0,
    expected: "no tool errors",
    actual:
      errors.length === 0
        ? "no errors"
        : errors.map((e) => `${e.name}: ${e.result.substring(0, 100)}`),
    message: errors.length > 0 ? `${errors.length} tool(s) returned errors` : undefined,
  };
}

function evaluateOutputJson(
  assertion: Extract<TestAssertion, { type: "output_json" }>,
  output: string
): AssertionResult {
  // Try to extract JSON from output (fenced code block or raw braces)
  const jsonMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/) ?? output.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    return {
      type: "output_json",
      passed: false,
      expected: "JSON output",
      actual: output.substring(0, 300),
      message: "No JSON found in output",
    };
  }
  try {
    const parsed = JSON.parse(jsonMatch[1]);
    if (assertion.contains) {
      for (const [key, value] of Object.entries(assertion.contains)) {
        if (JSON.stringify(parsed[key]) !== JSON.stringify(value)) {
          return {
            type: "output_json",
            passed: false,
            expected: assertion.contains,
            actual: parsed,
            message: `JSON key '${key}' = ${JSON.stringify(parsed[key])}, expected ${JSON.stringify(value)}`,
          };
        }
      }
    }
    return { type: "output_json", passed: true, expected: "valid JSON", actual: parsed };
  } catch (e: any) {
    return {
      type: "output_json",
      passed: false,
      expected: "valid JSON",
      actual: jsonMatch[1].substring(0, 300),
      message: `Invalid JSON: ${e.message}`,
    };
  }
}

// ─── Semantic (LLM-as-Judge) Assertion ────────────────────────────────────

const JUDGE_SYSTEM_PROMPT = `You are a test assertion judge. Your ONLY job is to evaluate whether an LLM agent's output meets specific criteria.

You MUST follow this EXACT response format:

EVIDENCE:
- Quote or paraphrase 2-3 specific parts of the output that are relevant to the criteria
- If checking for absence of something, note what you searched for and confirm it is/isn't there

REASONING:
- In 1-2 sentences, explain how the evidence relates to the criteria
- Apply the PRINCIPLE OF CHARITY: if the output reasonably satisfies the criteria, even imperfectly, that is a PASS
- Only fail if the output clearly and unambiguously violates the criteria

VERDICT: PASS
or
VERDICT: FAIL

IMPORTANT RULES:
- Your response MUST end with a line starting with "VERDICT:" followed by PASS or FAIL
- Be fair, not harsh. The criteria describe the MINIMUM bar, not perfection
- Partial credit counts: if 80% of the criteria is met, that is a PASS
- "Does not contain X" means X should not be a significant part of the response — brief mentions while declining don't count
- Do NOT use any tools. Just respond with your judgment.`;

async function evaluateSemanticAssertion(
  assertion: Extract<TestAssertion, { type: "semantic" }>,
  output: string,
  toolCalls: CapturedToolCall[],
  config: LUnitConfig
): Promise<AssertionResult> {
  const judgeModelStr = assertion.judge_model ?? config.default_judge_model ?? config.default_model;

  try {
    let model: any, authStorage: any, modelRegistry: any;
    try {
      ({ model, authStorage, modelRegistry } = await resolveModel(judgeModelStr));
    } catch {
      return {
        type: "semantic",
        passed: false,
        expected: assertion.criteria,
        actual: `Judge model not found: ${judgeModelStr}`,
        message: `Cannot evaluate: judge model '${judgeModelStr}' not found`,
      };
    }

    const loader = new DefaultResourceLoader({
      systemPromptOverride: () => JUDGE_SYSTEM_PROMPT,
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
    });
    await loader.reload();

    const { session } = await createAgentSession({
      model,
      thinkingLevel: "off",
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      resourceLoader: loader,
      authStorage,
      modelRegistry,
      tools: [], // Judge uses no tools
    });

    let judgeOutput = "";
    session.subscribe((event: any) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        judgeOutput += event.assistantMessageEvent.delta;
      }
    });

    const toolSummary =
      toolCalls.length > 0
        ? toolCalls
            .map(
              (tc) =>
                `- ${tc.name}(${JSON.stringify(tc.params).substring(0, 300)}) → ${tc.isError ? "ERROR: " : ""}${tc.result.substring(0, 300)}`
            )
            .join("\n")
        : "(no tools were called)";

    await session.prompt(
      `## Criteria\n${assertion.criteria}\n\n## Agent Output\n${output.substring(0, 3000)}\n\n## Tool Calls\n${toolSummary}\n\nEvaluate whether the output meets the criteria. Follow the EVIDENCE → REASONING → VERDICT format exactly.`
    );

    session.dispose();

    // Parse verdict — look for "VERDICT: PASS" or "VERDICT: FAIL" anywhere in output
    const verdictMatch = judgeOutput.match(/VERDICT:\s*(PASS|FAIL)/i);
    let passed: boolean;
    if (verdictMatch) {
      passed = verdictMatch[1].toUpperCase() === "PASS";
    } else {
      // Fallback: check first/last lines for bare PASS/FAIL
      const lines = judgeOutput.trim().split("\n").map(l => l.trim().toUpperCase());
      const lastLine = lines[lines.length - 1];
      const firstLine = lines[0];
      passed = lastLine.startsWith("PASS") || firstLine.startsWith("PASS");
    }

    // Extract reasoning for the report
    const reasoningMatch = judgeOutput.match(/REASONING:\s*([\s\S]*?)(?=VERDICT:|$)/i);
    const reasoning = reasoningMatch ? reasoningMatch[1].trim() : judgeOutput.trim();

    return {
      type: "semantic",
      passed,
      expected: assertion.criteria,
      actual: judgeOutput.trim().substring(0, 600),
      message: passed ? undefined : `Judge: ${reasoning.substring(0, 400)}`,
    };
  } catch (e: any) {
    return {
      type: "semantic",
      passed: false,
      expected: assertion.criteria,
      actual: `Evaluation error: ${e.message}`,
      message: `Semantic evaluation failed: ${e.message}`,
    };
  }
}

// ─── Evaluate All Assertions ──────────────────────────────────────────────

export async function evaluateAssertions(
  assertions: TestAssertion[],
  output: string,
  toolCalls: CapturedToolCall[],
  config: LUnitConfig
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];

  for (const assertion of assertions) {
    let result: AssertionResult;

    switch (assertion.type) {
      case "tool_called":
        result = evaluateToolCalled(assertion, toolCalls);
        break;
      case "tool_not_called":
        result = evaluateToolNotCalled(assertion, toolCalls);
        break;
      case "output_contains":
        result = evaluateOutputContains(assertion, output);
        break;
      case "output_not_contains":
        result = evaluateOutputNotContains(assertion, output);
        break;
      case "output_matches":
        result = evaluateOutputMatches(assertion, output);
        break;
      case "no_error":
        result = evaluateNoError(toolCalls);
        break;
      case "output_json":
        result = evaluateOutputJson(assertion, output);
        break;
      case "semantic":
        result = await evaluateSemanticAssertion(assertion, output, toolCalls, config);
        break;
      default:
        result = {
          type: (assertion as any).type,
          passed: false,
          expected: "known assertion type",
          actual: (assertion as any).type,
          message: `Unknown assertion type: ${(assertion as any).type}`,
        };
    }

    results.push(result);
  }

  return results;
}

// ─── Test Runner ──────────────────────────────────────────────────────────

export async function runSingleTest(
  test: TestDefinition,
  testFilePath: string,
  config: LUnitConfig,
  cwd: string,
  options: {
    modelOverride?: string;
    onProgress?: (msg: string) => void;
  }
): Promise<TestResult> {
  const startTime = Date.now();
  const modelStr = options.modelOverride ?? test.model ?? config.default_model;

  try {
    // ── Resolve model ───────────────────────────────────────────────
    const { model, authStorage, modelRegistry } = await resolveModel(modelStr);

    options.onProgress?.(`Setting up session for "${test.name}" with ${modelStr}...`);

    // ── Resource loader ─────────────────────────────────────────────
    // Use a non-existent agentDir to prevent global extensions/skills from leaking
    // into the isolated test session. Only test-specified resources are loaded.
    const isolatedDir = join(cwd, ".lunit", ".isolated");
    const loaderOpts: any = {
      cwd: isolatedDir,
      agentDir: isolatedDir,
    };

    // Skills
    if (test.context?.skills?.length) {
      const skills: Skill[] = test.context.skills.map((sp, i) => {
        const resolved = resolve(cwd, sp);
        return {
          name: `test-skill-${i}`,
          description: `Test skill from ${sp}`,
          filePath: resolved,
          baseDir: dirname(resolved),
          source: "custom" as const,
        };
      });
      loaderOpts.skillsOverride = () => ({ skills, diagnostics: [] });
    } else {
      loaderOpts.skillsOverride = () => ({ skills: [], diagnostics: [] });
    }

    // System prompt
    if (test.context?.system_prompt) {
      loaderOpts.systemPromptOverride = () => test.context!.system_prompt!;
    }

    // AGENTS.md — always override to prevent global AGENTS.md from leaking in
    if (test.context?.agents_md) {
      loaderOpts.agentsFilesOverride = () => ({
        agentsFiles: [{ path: "/test/AGENTS.md", content: test.context!.agents_md! }],
      });
    } else {
      loaderOpts.agentsFilesOverride = () => ({ agentsFiles: [] });
    }

    // Extensions — only load what the test specifies
    if (test.context?.extensions?.length) {
      loaderOpts.additionalExtensionPaths = test.context.extensions.map((p) => resolve(cwd, p));
    }

    // No prompt templates in isolated tests
    loaderOpts.promptsOverride = () => ({ prompts: [], diagnostics: [] });

    const loader = new DefaultResourceLoader(loaderOpts);
    await loader.reload();

    // ── Create session ──────────────────────────────────────────────
    const sessionOpts: any = {
      model,
      thinkingLevel: "off" as const,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 2 },
      }),
      resourceLoader: loader,
      authStorage,
      modelRegistry,
    };

    // Built-in tools
    if (test.context?.tools !== undefined) {
      if (test.context.tools.length === 0) {
        sessionOpts.tools = [];
      } else {
        sessionOpts.tools = resolveBuiltinTools(test.context.tools, cwd);
      }
    }

    // Mock tools — register as custom tools so the LLM can call them
    if (test.context?.mocks?.length) {
      sessionOpts.customTools = buildMockTools(test.context.mocks);
    }

    const { session } = await createAgentSession(sessionOpts);

    // ── Capture events ──────────────────────────────────────────────
    const toolCallsInProgress = new Map<string, Partial<CapturedToolCall>>();
    const toolCalls: CapturedToolCall[] = [];
    let outputText = "";

    session.subscribe((event: any) => {
      // Capture streaming text
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        outputText += event.assistantMessageEvent.delta;
      }
      // Capture tool call start (with params)
      if (event.type === "tool_execution_start") {
        const id = event.toolCallId ?? `tc-${Date.now()}`;
        toolCallsInProgress.set(id, {
          id,
          name: event.toolName ?? "unknown",
          params: event.args ?? event.params ?? {},
        });
      }
      // Capture tool call end (with result)
      if (event.type === "tool_execution_end") {
        const id = event.toolCallId ?? `tc-${Date.now()}`;
        const tc = toolCallsInProgress.get(id);
        if (tc) {
          tc.isError = event.isError ?? false;
          tc.result = typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? "");
          toolCalls.push(tc as CapturedToolCall);
          toolCallsInProgress.delete(id);
        } else {
          // Fallback: create from end event alone
          toolCalls.push({
            id,
            name: event.toolName ?? "unknown",
            params: {},
            result: typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? ""),
            isError: event.isError ?? false,
          });
        }
      }
    });

    // ── Run prompts ─────────────────────────────────────────────────
    options.onProgress?.(`Running prompt for "${test.name}"...`);
    const prompts = test.prompts ?? [test.prompt];
    for (const prompt of prompts) {
      await session.prompt(prompt);
    }

    session.dispose();

    // ── Evaluate assertions ─────────────────────────────────────────
    options.onProgress?.(`Evaluating assertions for "${test.name}"...`);
    const assertionResults = await evaluateAssertions(test.assertions, outputText, toolCalls, config);
    const allPassed = assertionResults.every((a) => a.passed);

    return {
      name: test.name,
      suite: test.suite,
      file: testFilePath,
      status: allPassed ? "pass" : "fail",
      duration_ms: Date.now() - startTime,
      model: modelStr,
      prompt: prompts.join("\n---\n"),
      output: outputText,
      tool_calls: toolCalls,
      assertions: assertionResults,
    };
  } catch (error: any) {
    return {
      name: test.name,
      suite: test.suite,
      file: testFilePath,
      status: "error",
      duration_ms: Date.now() - startTime,
      model: modelStr,
      prompt: test.prompts?.[0] ?? test.prompt,
      output: "",
      tool_calls: [],
      assertions: [],
      error: error.message ?? String(error),
    };
  }
}
