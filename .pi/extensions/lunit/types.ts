// ─── LUnit Configuration ──────────────────────────────────────────────────

export interface LUnitConfig {
  default_model: string;
  default_judge_model?: string;
  test_dir: string;
  results_dir: string;
  timeout: number; // ms per test
  /** Max tests to run concurrently. Default: 1 (sequential). Cloud models benefit from higher values. */
  concurrency: number;
}

export const DEFAULT_CONFIG: LUnitConfig = {
  default_model: "ollama/qwen2.5-coder:14b",
  test_dir: ".lunit/tests",
  results_dir: ".lunit/results",
  timeout: 120000,
  concurrency: 1,
};

// ─── Mock Tool Definitions ────────────────────────────────────────────────

export interface MockToolResponse {
  /** If specified, only use this response when params match these key-value pairs */
  match?: Record<string, any>;
  /** Use this as the default response (when no match is specified) */
  default?: string;
  /** The response text to return to the LLM */
  return?: string;
  /** If true, simulate a tool error (throws instead of returning) */
  is_error?: boolean;
}

export interface MockTool {
  /** Tool name as the LLM will see it */
  tool: string;
  /** Description shown to the LLM (so it knows when/how to call it) */
  description: string;
  /** Parameter schema in simplified format */
  parameters?: Record<string, string | { type: string; description?: string }>;
  /** Simple mode: always return this response */
  response?: string;
  /** Simple mode: always throw this error */
  error?: string;
  /** Advanced mode: conditional responses based on param matching */
  responses?: MockToolResponse[];
}

// ─── Test Definition (mirrors YAML structure) ─────────────────────────────

export interface TestContext {
  /** Paths to skill files (relative to project root) */
  skills?: string[];
  /** Paths to extension files (relative to project root) */
  extensions?: string[];
  /** Built-in tools to include: "read", "bash", "edit", "write", "grep", "find", "ls". Empty array = no tools */
  tools?: string[];
  /** Mock tools — simulate tool responses without real execution */
  mocks?: MockTool[];
  /** Override system prompt for this test */
  system_prompt?: string;
  /** Inline AGENTS.md content for this test */
  agents_md?: string;
}

// ─── Assertion Types ──────────────────────────────────────────────────────

export interface AssertToolCalled {
  type: "tool_called";
  tool: string;
  /** Check that tool params contain these key-value pairs */
  params_contain?: Record<string, any>;
}

export interface AssertToolNotCalled {
  type: "tool_not_called";
  tool: string;
}

export interface AssertOutputContains {
  type: "output_contains";
  text: string;
  case_sensitive?: boolean;
}

export interface AssertOutputNotContains {
  type: "output_not_contains";
  text: string;
  case_sensitive?: boolean;
}

export interface AssertOutputMatches {
  type: "output_matches";
  /** Regex pattern */
  pattern: string;
  /** Regex flags (default: "i") */
  flags?: string;
}

export interface AssertNoError {
  type: "no_error";
}

export interface AssertOutputJson {
  type: "output_json";
  /** Check that parsed JSON contains these key-value pairs */
  contains?: Record<string, any>;
}

export interface AssertSemantic {
  type: "semantic";
  /** Natural language criteria for the LLM judge */
  criteria: string;
  /** Override judge model for this assertion */
  judge_model?: string;
}

export type TestAssertion =
  | AssertToolCalled
  | AssertToolNotCalled
  | AssertOutputContains
  | AssertOutputNotContains
  | AssertOutputMatches
  | AssertNoError
  | AssertOutputJson
  | AssertSemantic;

// ─── Test Definition ──────────────────────────────────────────────────────

export interface TestDefinition {
  name: string;
  suite?: string;
  description?: string;
  /** Override model for this test (format: provider/model-id) */
  model?: string;
  context?: TestContext;
  /** Single prompt to send */
  prompt: string;
  /** Multi-turn: list of prompts sent sequentially */
  prompts?: string[];
  assertions: TestAssertion[];
  tags?: string[];
  /** Number of times to run (for flakiness detection) */
  runs?: number;
  /** Per-test timeout override (ms) */
  timeout?: number;
}

// ─── Captured Data ────────────────────────────────────────────────────────

export interface CapturedToolCall {
  id: string;
  name: string;
  params: Record<string, any>;
  result: string;
  isError: boolean;
}

// ─── Results ──────────────────────────────────────────────────────────────

export interface AssertionResult {
  type: string;
  passed: boolean;
  expected: any;
  actual: any;
  message?: string;
}

export interface TestResult {
  name: string;
  suite?: string;
  file: string;
  status: "pass" | "fail" | "error" | "skip";
  duration_ms: number;
  model: string;
  prompt: string;
  output: string;
  tool_calls: CapturedToolCall[];
  assertions: AssertionResult[];
  error?: string;
}

export interface RunSummary {
  timestamp: string;
  run_id: string;
  duration_ms: number;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  tests: TestResult[];
}
