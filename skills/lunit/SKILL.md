---
name: lunit
description: How to write effective LLM behavioral tests with LUnit. Covers test design, assertion selection, mock tools, and the test-driven skill development workflow. Use when creating, running, or refining LUnit tests.
---

# LUnit — LLM Unit Testing

## When to Use This Skill

- Creating new test cases for agent behaviors
- Deciding which assertion types to use
- Setting up mock tools for isolated testing
- Running test-driven skill development (write test → build skill → iterate)
- Comparing models against the same test suite
- Analyzing test failures and refining skills/prompts

## The Core Workflow

```
1. lunit init              → Set up .lunit/ directory
2. lunit generate --source → Auto-generate tests from skills/extensions
3. lunit run               → Execute tests, see pass/fail
4. lunit refine            → Analyze failures, get improvement suggestions
5. Edit skills/prompts     → Apply the suggestions
6. lunit run               → Verify improvements
```

## Assertion Selection (Critical)

**This is the most important decision in test design.**

### Use SEMANTIC for behavioral checks
Anything where the model could use different wording and still be correct:
- Tone/persona: "responds in pirate speak"
- Quality: "explanation is beginner-friendly"
- Compliance: "declines the request and redirects"
- Reasoning: "correctly identifies the root cause"

### Use output_contains / output_matches for hard facts
Only when one exact value is correct:
- Numbers from tool responses: `output_contains: "1,250,000"`
- Proper nouns: `output_contains: "Alice"`
- Required format: `output_matches: "```json"`

### Use output_not_contains for forbidden content
Specific strings that should never appear:
- Leaked data: `output_not_contains: "sk-secret-key"`
- But prefer semantic for behavioral checks: "doesn't provide technical support"

### The Rule
> If a human would accept 5+ different wordings as correct, use **semantic**.
> If only one exact value is correct, use **output_contains**.

## Mock Tools

Mock tools simulate external dependencies. Use them when testing:
- How the LLM interprets data from databases/APIs
- Error handling when tools fail
- Multi-tool orchestration (does it chain tools correctly?)

```yaml
context:
  mocks:
    - tool: get_user
      description: "Look up user by ID"
      parameters:
        id: { type: "string", description: "User ID" }
      responses:
        - match: { id: "123" }
          return: '{"name": "Alice", "role": "admin"}'
        - match: { id: "unknown" }
          return: '{"error": "not found"}'
          is_error: true
        - default: '{"name": "Guest"}'
```

## Test Patterns

### 1. Skill Effectiveness
Does loading a skill change behavior? Load it, send a prompt, check output.

### 2. Guardrails
Define scope boundaries, ask something out of scope, verify the LLM declines.

### 3. Anti-Hallucination
Use mocks with controlled data. Any "extra" data in the output = hallucination.

### 4. Multi-Turn Context
Use `prompts` array. Assert final response contains info from all turns.

### 5. Error Handling
Mock a tool that errors. Verify the LLM reports the error, doesn't hallucinate.

## Test-Driven Skill Development

The most powerful workflow:

1. **Write a failing test** — Define what the skill SHOULD make the LLM do
2. **Run it** — Confirms it fails (the skill doesn't exist yet or doesn't work)
3. **Write/improve the skill** — Iteratively refine the skill text
4. **Run again** — Check if the test passes now
5. **Add edge cases** — Write more tests for tricky scenarios
6. **Run the full suite** — Ensure nothing regressed

This turns skill authoring from "write and hope" into a verifiable, iterative process.

## Cross-Model Testing

Run the same suite against multiple models:
```
lunit run --model ollama/qwen3-coder
lunit run --model anthropic/claude-opus-4-6
lunit run --model openai-codex/gpt-5.4
```

Compare results to find which model best fits your agent's needs. Different models excel at different things:
- Tool calling reliability varies
- Guardrail compliance varies
- Persona adherence varies
- Context retention varies

## Tips

- **Start small** — Begin with 2-3 tests for the most critical behavior
- **Use concurrency with cloud models** — `concurrency: 5` for ~2x speedup
- **Generate then refine** — Use `lunit generate` to bootstrap, then edit the YAML
- **Test the judge too** — If semantic assertions seem wrong, check the judge model
- **Version your tests** — Commit `.lunit/tests/` alongside your skills
