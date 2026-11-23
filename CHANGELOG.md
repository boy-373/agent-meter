# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] — 2026-11-23

Published as **`@boy-373/agent-meter`**. The previous name `agent-meter-kernel`
is deprecated and points here.

### Changed

- **Package name** `agent-meter-kernel` → `@boy-373/agent-meter`. The unscoped
  name `agent-meter` could not be published: npm's similarity check rejects it
  because `agentmeter` already exists (a third-party usage-billing SDK).
- **Description** now names the LLM vendors explicitly, so the package is
  discoverable when someone searches for budget control next to a provider.
- **Keywords** expanded from 10 to 28 (`openai`, `anthropic`, `claude`, `gemini`,
  `langchain`, `crewai`, `mcp`, `finops`, `llmops`, …).
- **README** opens with what the package decides, not what it counts, and shows
  a zero-config command (`npx @boy-373/agent-meter models`) above the fold.

### Added

- GitHub Actions CI: build + test on Node 18 / 20 / 22, plus a package sanity
  job (`npm pack --dry-run` and a CLI smoke test).
- This changelog.

### Unchanged

- No API changes. The exported surface, the price table, the three store
  backends and the CLI flags are identical to 0.1.3.

## [0.1.3] — 2026-11-21

- Last release under the name `agent-meter-kernel`.
- 44 built-in model prices across Qwen, DeepSeek, Doubao, GLM, Kimi and MiniMax.
- Memory / JSONL / HTTP store backends, Express middleware, CLI.

## [0.1.0] — 2026-11-20

- First public release.
