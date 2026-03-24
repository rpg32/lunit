import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import type { RunSummary, TestResult, LUnitConfig, TestDefinition } from "./types.ts";
import { parseTestFile } from "./engine.ts";

// ─── Formatting ───────────────────────────────────────────────────────────

export function formatRunSummary(summary: RunSummary): string {
  const lines: string[] = [];

  lines.push(`\n🧪 LUnit Run: ${summary.run_id}`);
  lines.push(`   ${summary.timestamp} | ${(summary.duration_ms / 1000).toFixed(1)}s total\n`);

  for (const test of summary.tests) {
    const icon = test.status === "pass" ? "✅" : test.status === "fail" ? "❌" : "⚠️";
    const duration = `${(test.duration_ms / 1000).toFixed(1)}s`;
    const suite = test.suite ? `[${test.suite}] ` : "";
    lines.push(`  ${icon} ${suite}${test.name}  ${duration}`);

    if (test.status === "fail") {
      for (const a of test.assertions.filter((a) => !a.passed)) {
        lines.push(`     ↳ ${a.type}: ${a.message}`);
      }
    }
    if (test.status === "error") {
      lines.push(`     ↳ ERROR: ${test.error}`);
    }
  }

  lines.push(``);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(
    `📊 ${summary.passed}/${summary.total} passed | ${summary.failed} failed | ${summary.errors} errors | ${(summary.duration_ms / 1000).toFixed(1)}s`
  );

  return lines.join("\n");
}

export function formatTestDetail(test: TestResult): string {
  const lines: string[] = [];
  const icon = test.status === "pass" ? "✅" : test.status === "fail" ? "❌" : "⚠️";

  lines.push(`\n${icon} ${test.name}`);
  lines.push(`   Model: ${test.model} | Duration: ${(test.duration_ms / 1000).toFixed(1)}s | Status: ${test.status}`);
  lines.push(`   File: ${test.file}`);
  lines.push(`   Prompt: ${test.prompt.substring(0, 300)}${test.prompt.length > 300 ? "..." : ""}`);

  if (test.output) {
    lines.push(`\n   Output (${test.output.length} chars):`);
    const outputPreview = test.output.substring(0, 600);
    for (const line of outputPreview.split("\n")) {
      lines.push(`   │ ${line}`);
    }
    if (test.output.length > 600) lines.push(`   │ ... (truncated)`);
  }

  if (test.tool_calls.length > 0) {
    lines.push(`\n   Tool Calls (${test.tool_calls.length}):`);
    for (const tc of test.tool_calls) {
      const params = JSON.stringify(tc.params).substring(0, 200);
      const icon = tc.isError ? "🔴" : "🟢";
      lines.push(`   ${icon} ${tc.name}(${params})`);
      if (tc.result) {
        lines.push(`      → ${tc.result.substring(0, 200)}${tc.result.length > 200 ? "..." : ""}`);
      }
    }
  }

  lines.push(`\n   Assertions (${test.assertions.length}):`);
  for (const a of test.assertions) {
    const icon = a.passed ? "✅" : "❌";
    lines.push(`   ${icon} ${a.type}`);
    if (!a.passed && a.message) {
      lines.push(`      ${a.message}`);
    }
    if (!a.passed) {
      lines.push(`      Expected: ${JSON.stringify(a.expected).substring(0, 200)}`);
      lines.push(`      Actual:   ${JSON.stringify(a.actual).substring(0, 200)}`);
    }
  }

  if (test.error) {
    lines.push(`\n   ⚠️ Error: ${test.error}`);
  }

  return lines.join("\n");
}

// ─── Results Persistence ──────────────────────────────────────────────────

export async function saveResults(summary: RunSummary, resultsDir: string): Promise<string> {
  const dir = join(resultsDir, summary.run_id);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "results.json");
  await writeFile(path, JSON.stringify(summary, null, 2));
  return path;
}

export async function loadLastResults(resultsDir: string): Promise<RunSummary | null> {
  try {
    const entries = await readdir(resultsDir);
    const sorted = entries.sort().reverse();
    if (sorted.length === 0) return null;
    const path = join(resultsDir, sorted[0], "results.json");
    const content = await readFile(path, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function loadResultsByRunId(
  resultsDir: string,
  runId: string
): Promise<RunSummary | null> {
  try {
    const path = join(resultsDir, runId, "results.json");
    const content = await readFile(path, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// ─── Refinement Analysis ──────────────────────────────────────────────────

export async function buildRefinementData(
  summary: RunSummary,
  cwd: string,
  config: LUnitConfig
): Promise<string> {
  const failedTests = summary.tests.filter((t) => t.status === "fail" || t.status === "error");
  if (failedTests.length === 0) {
    return "✅ All tests passed! No refinement needed.";
  }

  const sections: string[] = [];

  sections.push(`# LUnit Refinement Analysis\n`);
  sections.push(`**${failedTests.length}** of **${summary.total}** tests need attention.\n`);
  sections.push(`Run: ${summary.run_id} | ${summary.timestamp}\n`);

  for (const test of failedTests) {
    const statusIcon = test.status === "fail" ? "❌" : "⚠️";
    sections.push(`---\n`);
    sections.push(`## ${statusIcon} ${test.name}\n`);
    sections.push(`- **Model:** ${test.model}`);
    sections.push(`- **Prompt:** ${test.prompt}`);
    sections.push(`- **Status:** ${test.status}`);

    if (test.output) {
      sections.push(`\n### Agent Output\n\`\`\`\n${test.output.substring(0, 1500)}\n\`\`\``);
    }

    if (test.tool_calls.length > 0) {
      sections.push(`\n### Tool Calls`);
      for (const tc of test.tool_calls) {
        sections.push(
          `- \`${tc.name}\`(${JSON.stringify(tc.params).substring(0, 300)}) → ${tc.isError ? "**ERROR:** " : ""}${tc.result.substring(0, 300)}`
        );
      }
    }

    // Failed assertions with details
    const failedAssertions = test.assertions.filter((a) => !a.passed);
    if (failedAssertions.length > 0) {
      sections.push(`\n### Failed Assertions`);
      for (const a of failedAssertions) {
        sections.push(`- **${a.type}**: ${a.message ?? "failed"}`);
        sections.push(`  - Expected: \`${JSON.stringify(a.expected).substring(0, 300)}\``);
        sections.push(`  - Actual: \`${JSON.stringify(a.actual).substring(0, 300)}\``);
      }
    }

    if (test.error) {
      sections.push(`\n### Error\n\`\`\`\n${test.error}\n\`\`\``);
    }

    // Load the test definition to get context info for refinement
    try {
      const testDef = await parseTestFile(test.file);

      // Load and include skill source code so the LLM can suggest improvements
      if (testDef.context?.skills?.length) {
        sections.push(`\n### Loaded Skills (source code for refinement)`);
        for (const skillPath of testDef.context.skills) {
          const resolved = resolve(cwd, skillPath);
          try {
            const content = await readFile(resolved, "utf-8");
            sections.push(`\n#### \`${skillPath}\`\n\`\`\`markdown\n${content.substring(0, 3000)}\n\`\`\``);
          } catch {
            sections.push(`\n#### \`${skillPath}\` — ⚠️ FILE NOT FOUND`);
          }
        }
      }

      if (testDef.context?.system_prompt) {
        sections.push(
          `\n### System Prompt\n\`\`\`\n${testDef.context.system_prompt.substring(0, 1000)}\n\`\`\``
        );
      }

      if (testDef.context?.agents_md) {
        sections.push(
          `\n### AGENTS.md Context\n\`\`\`markdown\n${testDef.context.agents_md.substring(0, 1500)}\n\`\`\``
        );
      }

      // Show mock tool configurations if present
      if (testDef.context?.mocks?.length) {
        sections.push(`\n### Mock Tools`);
        for (const mock of testDef.context.mocks) {
          sections.push(`- **${mock.tool}**: ${mock.description}`);
          if (mock.responses) {
            sections.push(`  - ${mock.responses.length} conditional response(s) configured`);
          }
        }
      }
    } catch {
      // Could not load test definition — skip context
    }
  }

  sections.push(`\n---\n`);
  sections.push(`## Refinement Guidance\n`);
  sections.push(`Based on the failures above, consider:\n`);
  sections.push(`1. **Skills**: Do they provide clear enough guidance for the tested behaviors?`);
  sections.push(`2. **System prompt**: Are expectations stated clearly and unambiguously?`);
  sections.push(`3. **Tool descriptions**: Are they detailed enough for correct usage?`);
  sections.push(`4. **AGENTS.md**: Do the guidelines cover the tested scenarios?`);
  sections.push(`5. **Examples**: Would adding worked examples to skills help the model?`);
  sections.push(`6. **Mock coverage**: Are mock responses realistic? Missing edge cases?`);
  sections.push(
    `\nPlease analyze each failure and suggest specific text changes to the skills, prompts, or tool descriptions that would fix the behavior.`
  );

  return sections.join("\n");
}
