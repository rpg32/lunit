import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { parse as parseYaml } from "yaml";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, resolve, relative } from "node:path";

import type { RunSummary, TestDefinition, LUnitConfig } from "./types.ts";
import {
  loadConfig,
  discoverTests,
  parseTestFile,
  runSingleTest,
  runTestsParallel,
  generateTests,
} from "./engine.ts";
import {
  formatRunSummary,
  formatTestDetail,
  saveResults,
  loadLastResults,
  buildRefinementData,
} from "./reporter.ts";

// ─── Sample Files ─────────────────────────────────────────────────────────

const SAMPLE_CONFIG = `# LUnit Configuration

# Default model for test execution
default_model: "ollama/qwen2.5-coder:14b"

# Default model for semantic (LLM-as-judge) assertions
# Uses a stronger model for more reliable judging
# default_judge_model: "anthropic/claude-sonnet-4-20250514"

# Directories (relative to project root)
test_dir: ".lunit/tests"
results_dir: ".lunit/results"

# Default timeout per test (ms)
timeout: 120000

# Max tests to run in parallel (default: 1 = sequential)
# Use higher values with cloud models for faster runs
# Local models (Ollama) should stay at 1
concurrency: 1
`;

const SAMPLE_TEST = `# Sample LUnit Test
# Verifies basic LLM response behavior

name: "Basic greeting response"
suite: "smoke"
description: "Verify the LLM responds appropriately to a simple greeting"

# Context setup
context:
  tools: []  # No built-in tools needed
  system_prompt: "You are a helpful assistant. Be concise and friendly."

  # Mock tools example (uncomment to try):
  # mocks:
  #   - tool: get_user
  #     description: "Look up a user by ID"
  #     parameters:
  #       user_id: { type: "string", description: "The user's ID" }
  #     responses:
  #       - match: { user_id: "123" }
  #         return: '{"id": "123", "name": "Alice", "role": "admin"}'
  #       - match: { user_id: "999" }
  #         return: '{"error": "user not found"}'
  #         is_error: true
  #       - default: '{"id": "0", "name": "Unknown"}'

# The prompt to send
prompt: "Hello! How are you doing today?"

# Assertions to verify
assertions:
  - type: output_contains
    text: "hello"
    case_sensitive: false

  - type: no_error

  # Uncomment for semantic assertion:
  # - type: semantic
  #   criteria: "The response is friendly, acknowledges the greeting, and asks about the user or offers help"
  #   judge_model: "ollama/qwen2.5-coder:14b"

tags: ["smoke", "basic"]
`;

const MOCK_TEST_SAMPLE = `# Mock Tool Test Example
# Demonstrates testing LLM behavior with simulated tool responses

name: "User lookup with mock database"
suite: "mocks"
description: "Test that the LLM correctly interprets user data from a mocked database tool"

context:
  tools: []  # No real tools
  system_prompt: "You are a user management assistant. Use the user_db tool to look up users when asked."

  mocks:
    - tool: user_db
      description: "Query the user database. Returns user records as JSON."
      parameters:
        action: { type: "string", description: "Action: lookup, search, or list" }
        query: { type: "string", description: "User ID or search term" }
      responses:
        - match: { action: "lookup", query: "alice" }
          return: '{"id": 1, "name": "Alice Johnson", "email": "alice@example.com", "role": "admin", "active": true}'
        - match: { action: "lookup", query: "bob" }
          return: '{"id": 2, "name": "Bob Smith", "email": "bob@example.com", "role": "viewer", "active": false}'
        - match: { action: "lookup", query: "unknown" }
          return: '{"error": "User not found"}'
          is_error: true
        - default: '[]'

prompt: "Can you look up the user 'alice' and tell me their role and email?"

assertions:
  - type: tool_called
    tool: user_db
    params_contain:
      action: "lookup"
      query: "alice"

  - type: output_contains
    text: "admin"
    case_sensitive: false

  - type: output_contains
    text: "alice@example.com"
    case_sensitive: false

  - type: no_error

tags: ["mocks", "user-management"]
`;

// ─── Init Action ──────────────────────────────────────────────────────────

async function initLUnit(cwd: string): Promise<string> {
  const lunitDir = join(cwd, ".lunit");
  await mkdir(join(lunitDir, "tests"), { recursive: true });
  await mkdir(join(lunitDir, "results"), { recursive: true });

  const configPath = join(lunitDir, "config.yml");
  const samplePath = join(lunitDir, "tests", "sample.test.yml");
  const mockSamplePath = join(lunitDir, "tests", "mock-example.test.yml");

  // Only write if files don't exist
  const writeIfNew = async (path: string, content: string) => {
    try {
      await stat(path);
    } catch {
      await writeFile(path, content);
    }
  };

  await writeIfNew(configPath, SAMPLE_CONFIG);
  await writeIfNew(samplePath, SAMPLE_TEST);
  await writeIfNew(mockSamplePath, MOCK_TEST_SAMPLE);

  return `✅ Initialized .lunit/ directory:

  📁 .lunit/
  ├── config.yml                    (test configuration)
  ├── tests/
  │   ├── sample.test.yml           (basic test example)
  │   └── mock-example.test.yml     (mock tool example)
  └── results/                      (test run results)

Next steps:
1. Edit config.yml to set your default model
2. Create test files in .lunit/tests/ (or use the 'create' action)
3. Run tests with the 'run' action`;
}

// ─── Extension Entry Point ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let lastRunSummary: RunSummary | null = null;

  // ── State Reconstruction ────────────────────────────────────────
  function reconstructState(ctx: ExtensionContext) {
    lastRunSummary = null;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === "lunit"
      ) {
        if (entry.message.details?.lastRun) {
          lastRunSummary = entry.message.details.lastRun;
        }
      }
    }
  }

  pi.on("session_start", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_switch", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_fork", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_e, ctx) => reconstructState(ctx));

  // ── Tool Registration ───────────────────────────────────────────
  pi.registerTool({
    name: "lunit",
    label: "LUnit",
    description:
      "LLM Unit Testing framework — create, run, and refine behavioral tests for agent systems. " +
      "Tests verify that LLMs produce expected outputs given specific prompts, skills, tools, and hooks. " +
      "Supports tool mocking to simulate external dependencies without real execution.",
    promptSnippet: "Create, run, and refine LLM behavioral unit tests (.lunit/)",
    promptGuidelines: [
      "Use `lunit` with action 'init' to set up the .lunit/ directory structure before creating tests",
      "Use `lunit` with action 'create' and provide test_content as valid YAML to define a new test",
      "Use `lunit` with action 'run' to execute tests — filter by suite, name, or tag",
      "Use `lunit` with action 'results' to view the last run's results in detail",
      "Use `lunit` with action 'refine' to analyze failures and get actionable improvement suggestions",
      "Test YAML supports 'context.mocks' for simulating tool responses without real execution",
      "Assertion types: tool_called, tool_not_called, output_contains, output_not_contains, output_matches, no_error, output_json, semantic",
      "Use `lunit` with action 'generate' and provide a source file path to auto-generate tests from skills, extensions, or system prompts",
      "Use `concurrency` parameter (e.g., 5) with cloud models to run tests in parallel for faster execution",
    ],
    parameters: Type.Object({
      action: StringEnum(["init", "create", "list", "run", "results", "refine", "generate"] as const),
      test_content: Type.Optional(
        Type.String({ description: "YAML content for a new test definition (for 'create')" })
      ),
      file_name: Type.Optional(
        Type.String({
          description: "File name for the test (for 'create', e.g. 'my-feature.test.yml')",
        })
      ),
      suite: Type.Optional(Type.String({ description: "Filter by test suite name" })),
      name: Type.Optional(Type.String({ description: "Filter by test name (partial match)" })),
      tag: Type.Optional(Type.String({ description: "Filter by tag" })),
      model: Type.Optional(
        Type.String({
          description: "Override model for test execution (format: provider/model-id)",
        })
      ),
      path: Type.Optional(Type.String({ description: "Path to a specific test file to run" })),
      verbose: Type.Optional(
        Type.Boolean({ description: "Show detailed output per test (default: false)" })
      ),
      concurrency: Type.Optional(
        Type.Number({
          description:
            "Max tests to run in parallel (default: from config, typically 1). Use higher values with cloud models.",
        })
      ),
      source: Type.Optional(
        Type.String({
          description:
            "For 'generate': path(s) to source files to generate tests from (skill .md, extension .ts, or system prompt). Comma-separated for multiple files.",
        })
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const config = await loadConfig(cwd);

      switch (params.action) {
        // ── INIT ────────────────────────────────────────────────
        case "init": {
          const result = await initLUnit(cwd);
          return { content: [{ type: "text", text: result }], details: {} };
        }

        // ── CREATE ──────────────────────────────────────────────
        case "create": {
          if (!params.test_content) {
            throw new Error(
              "test_content is required for 'create' action. Provide the full YAML test definition."
            );
          }

          // Validate YAML parses correctly
          let parsed: TestDefinition;
          try {
            parsed = parseYaml(params.test_content) as TestDefinition;
            if (!parsed.name) throw new Error("Test must have a 'name' field");
            if (!parsed.prompt && !parsed.prompts)
              throw new Error("Test must have a 'prompt' or 'prompts' field");
            if (!parsed.assertions?.length)
              throw new Error("Test must have at least one assertion");
          } catch (e: any) {
            throw new Error(`Invalid test YAML: ${e.message}`);
          }

          // Determine file path
          const fileName =
            params.file_name ??
            `${parsed.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "")}.test.yml`;
          const suiteDir = parsed.suite
            ? join(config.test_dir, parsed.suite)
            : config.test_dir;
          const fullDir = resolve(cwd, suiteDir);
          await mkdir(fullDir, { recursive: true });

          const filePath = join(fullDir, fileName);
          await writeFile(filePath, params.test_content);

          const relPath = relative(cwd, filePath);
          return {
            content: [
              {
                type: "text",
                text: `✅ Created test: ${relPath}\n\n  Name: ${parsed.name}\n  Suite: ${parsed.suite ?? "(none)"}\n  Assertions: ${parsed.assertions.length}\n  Tags: ${(parsed.tags ?? []).join(", ") || "(none)"}\n  Mocks: ${parsed.context?.mocks?.length ?? 0} tool(s)`,
              },
            ],
            details: { created: filePath },
          };
        }

        // ── LIST ────────────────────────────────────────────────
        case "list": {
          const testDir = resolve(cwd, config.test_dir);
          const tests = await discoverTests(testDir, {
            suite: params.suite,
            name: params.name,
            tag: params.tag,
          });

          if (tests.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No tests found. Run 'init' to create the directory structure, then 'create' to add tests.",
                },
              ],
              details: {},
            };
          }

          // Group by suite
          const bySuite: Record<string, typeof tests> = {};
          for (const t of tests) {
            const suite = t.test.suite ?? "(ungrouped)";
            if (!bySuite[suite]) bySuite[suite] = [];
            bySuite[suite].push(t);
          }

          const lines: string[] = [`📋 Found ${tests.length} test(s):\n`];
          for (const [suite, suiteTests] of Object.entries(bySuite)) {
            lines.push(`  📁 ${suite}`);
            for (const t of suiteTests) {
              const tags = t.test.tags?.length ? ` [${t.test.tags.join(", ")}]` : "";
              const assertCount = t.test.assertions?.length ?? 0;
              const mockCount = t.test.context?.mocks?.length ?? 0;
              const mockLabel = mockCount > 0 ? ` | ${mockCount} mock(s)` : "";
              const err = t.parseError ? " ⚠️ PARSE ERROR" : "";
              lines.push(`    📝 ${t.test.name} (${assertCount} assertions${mockLabel})${tags}${err}`);
              lines.push(`       ${relative(cwd, t.path)}`);
            }
          }

          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: {
              tests: tests.map((t) => ({
                name: t.test.name,
                suite: t.test.suite,
                path: t.path,
                tags: t.test.tags,
                assertionCount: t.test.assertions?.length ?? 0,
                mockCount: t.test.context?.mocks?.length ?? 0,
                parseError: t.parseError,
              })),
            },
          };
        }

        // ── RUN ─────────────────────────────────────────────────
        case "run": {
          const testDir = resolve(cwd, config.test_dir);
          let testsToRun: { path: string; test: TestDefinition; parseError?: string }[];

          if (params.path) {
            const fullPath = resolve(cwd, params.path.replace(/^@/, ""));
            const test = await parseTestFile(fullPath);
            testsToRun = [{ path: fullPath, test }];
          } else {
            testsToRun = await discoverTests(testDir, {
              suite: params.suite,
              name: params.name,
              tag: params.tag,
            });
          }

          if (testsToRun.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No tests matched. Use 'list' to see available tests, or remove filters.",
                },
              ],
              details: {},
            };
          }

          const concurrency = params.concurrency ?? config.concurrency ?? 1;
          const modeLabel = concurrency > 1 ? ` (${concurrency}x parallel)` : "";

          onUpdate?.({
            content: [
              {
                type: "text",
                text: `🧪 Running ${testsToRun.length} test(s)${modeLabel}...`,
              },
            ],
          });

          const runStart = Date.now();

          const results = await runTestsParallel(testsToRun, config, cwd, {
            modelOverride: params.model,
            concurrency,
            signal: signal ?? undefined,
            onProgress: (running, completed, total) => {
              const lines = [`🧪 Running${modeLabel}: ${completed}/${total} done`];
              if (running.length > 0) {
                lines.push("");
                for (const name of running) {
                  lines.push(`  ⏳ ${name}...`);
                }
              }
              onUpdate?.({ content: [{ type: "text", text: lines.join("\n") }] });
            },
          });

          // Build run summary
          const runId = new Date()
            .toISOString()
            .replace(/[:.]/g, "-")
            .replace("T", "_")
            .substring(0, 19);

          const summary: RunSummary = {
            timestamp: new Date().toISOString(),
            run_id: runId,
            duration_ms: Date.now() - runStart,
            total: results.length,
            passed: results.filter((r) => r.status === "pass").length,
            failed: results.filter((r) => r.status === "fail").length,
            errors: results.filter((r) => r.status === "error").length,
            skipped: results.filter((r) => r.status === "skip").length,
            tests: results,
          };

          // Persist results
          const resultsDir = resolve(cwd, config.results_dir);
          await saveResults(summary, resultsDir);
          lastRunSummary = summary;

          // Format output
          let output = formatRunSummary(summary);
          if (params.verbose) {
            output += "\n\n─── Detailed Results ───\n";
            for (const test of results) {
              output += formatTestDetail(test) + "\n";
            }
          }

          return {
            content: [{ type: "text", text: output }],
            details: { lastRun: summary },
          };
        }

        // ── RESULTS ─────────────────────────────────────────────
        case "results": {
          let summary = lastRunSummary;
          if (!summary) {
            const resultsDir = resolve(cwd, config.results_dir);
            summary = await loadLastResults(resultsDir);
          }

          if (!summary) {
            return {
              content: [
                {
                  type: "text",
                  text: "No test results found. Run tests first with action 'run'.",
                },
              ],
              details: {},
            };
          }

          // Filter by name if specified
          const filteredTests = params.name
            ? summary.tests.filter((t) =>
                t.name.toLowerCase().includes(params.name!.toLowerCase())
              )
            : summary.tests;

          let output = formatRunSummary(summary);

          // Show details for specific test or when verbose
          if (params.verbose || params.name) {
            output += "\n\n─── Detailed Results ───\n";
            for (const test of filteredTests) {
              output += formatTestDetail(test) + "\n";
            }
          }

          return {
            content: [{ type: "text", text: output }],
            details: { lastRun: summary },
          };
        }

        // ── REFINE ──────────────────────────────────────────────
        case "refine": {
          let summary = lastRunSummary;
          if (!summary) {
            const resultsDir = resolve(cwd, config.results_dir);
            summary = await loadLastResults(resultsDir);
          }

          if (!summary) {
            return {
              content: [
                {
                  type: "text",
                  text: "No test results to refine. Run tests first with action 'run'.",
                },
              ],
              details: {},
            };
          }

          const refinementData = await buildRefinementData(summary, cwd, config);

          return {
            content: [{ type: "text", text: refinementData }],
            details: { lastRun: summary },
          };
        }

        // ── GENERATE ──────────────────────────────────────────
        case "generate": {
          if (!params.source) {
            throw new Error(
              "source is required for 'generate' action. Provide path(s) to skill files, extensions, or system prompts. Comma-separated for multiple."
            );
          }

          const sourcePaths = params.source.split(",").map((s) => s.trim().replace(/^@/, ""));

          onUpdate?.({
            content: [
              {
                type: "text",
                text: `🔬 Analyzing ${sourcePaths.length} source file(s) for test generation...`,
              },
            ],
          });

          const { tests: generatedYamls, rawOutput } = await generateTests(
            sourcePaths,
            config,
            cwd,
            {
              modelOverride: params.model,
              onProgress: (msg) => {
                onUpdate?.({
                  content: [{ type: "text", text: `🔬 ${msg}` }],
                });
              },
            }
          );

          if (generatedYamls.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `⚠️ No valid test definitions were generated. The model output:\n\n${rawOutput.substring(0, 2000)}`,
                },
              ],
              details: { rawOutput: rawOutput.substring(0, 5000) },
            };
          }

          // Save each generated test
          const generatedDir = resolve(cwd, config.test_dir, "generated");
          await mkdir(generatedDir, { recursive: true });

          const savedFiles: string[] = [];
          for (let i = 0; i < generatedYamls.length; i++) {
            const yaml = generatedYamls[i];
            const parsed = (await import("yaml")).parse(yaml) as any;
            const name = parsed.name ?? `generated-test-${i + 1}`;
            const fileName = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "")}.test.yml`;
            const filePath = join(generatedDir, fileName);
            await writeFile(filePath, yaml);
            savedFiles.push(relative(cwd, filePath));
          }

          const lines = [
            `✅ Generated ${generatedYamls.length} test(s) from ${sourcePaths.length} source file(s):\n`,
          ];
          for (const f of savedFiles) {
            lines.push(`  📝 ${f}`);
          }
          lines.push(
            `\nTests saved to ${relative(cwd, generatedDir)}/`
          );
          lines.push(`Run them with: lunit run --suite generated`);

          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: {
              generated: savedFiles,
              count: generatedYamls.length,
              sources: sourcePaths,
            },
          };
        }

        default: {
          throw new Error(
            `Unknown action: ${params.action}. Valid actions: init, create, list, run, results, refine, generate`
          );
        }
      }
    },
  });
}
