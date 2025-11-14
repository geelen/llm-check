# llm-check

Test LLM API responses for reliability and prompt adherence when MCP (Model Context Protocol) tools are in the context. Run single tests with manual verification or benchmark mode for statistical analysis.

## Installation

No installation required. Use `bunx` to run directly:

```bash
bunx llm-check --help
```

Requires [Bun](https://bun.sh) runtime.

## Usage

```
MCP Check - Test Groq Responses API with MCP tools

Tests prompt adherence and reliability when MCP tools are in the context.
Supports single run (manual verification) and benchmark mode (statistical analysis).

Requirements:
  - Bun runtime (https://bun.sh)
  - Environment variables: GROQ_API_KEY

Usage:
  Single run:
    bun run mcp-check.ts -p "<prompt>" -m <model> -S "<label>:<url>" [-S "<label>:<url>" ...] [-x "<expectation>" ...]

  Benchmark mode:
    bun run mcp-check.ts -p "<prompt>" -m <model> -S "<label>:<url>" -n <runs> [-c <concurrency>] [-x "<expectation>" ...]

Arguments:
  -p <prompt>          Prompt text to send to the API (required)
  -m <model>           Model to use (required)
                       Common models: openai/gpt-oss-20b, openai/gpt-oss-120b, emberglow/small
  -S <label:url>       MCP server as "label:url" (multiple allowed, optional)
  -x <expectation>     Expected text in <answer> block (multiple allowed)
  -n <count>           Number of runs (default: 1)
  -c <concurrency>     Number of concurrent runs (default: 1)
  --prod               Use production API (https://api.groq.com) instead of localhost
  --base-url <url>     API base URL (default: http://localhost:8000, or https://api.groq.com with --prod)
  --endpoint <path>    API endpoint (default: /api/openai/v1/chat/completions)
  --header <header>    Custom header (multiple allowed)
  --help               Show this help message

Examples:
  # Single run with multiple servers
  bun run mcp-check.ts -p "What is the title?" \
    -m openai/gpt-oss-20b \
    -S "PPT:http://localhost:9001/sse" \
    -S "Word:http://localhost:9003/sse" \
    -x "slide"

  # Benchmark with custom headers
  bun run mcp-check.ts -p "What is trending?" \
    -m emberglow/small \
    -S "HF:https://huggingface.co/mcp" \
    --header "Groq-Model-Version: mcp-in-progress-preview" \
    -n 100 -c 8
```

## Features

- **Single Run Mode**: Execute one test and see the full response with colored output
- **Benchmark Mode**: Run multiple tests concurrently and analyze pass rates
- **Expectation Checking**: Define expected text that should appear in response `<answer>` blocks
- **MCP Tool Support**: Test LLM responses when MCP tools are available in context
- **Flexible Configuration**: Custom API endpoints, headers, and base URLs

## License

MIT
