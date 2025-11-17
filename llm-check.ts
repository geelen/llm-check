#!/usr/bin/env bun

import { parseArgs } from "util";
import { mkdtemp, mkdir, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

async function loadUsageFromReadme(): Promise<string> {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const readmePath = join(__dirname, "README.md");
    const readme = await readFile(readmePath, "utf-8");
    
    // Extract the usage section - find the ## Usage heading and then the code block after it
    const usageMatch = readme.match(/## Usage\s*\n\s*```\n([\s\S]*?)\n```/);
    if (usageMatch && usageMatch[1]) {
      return usageMatch[1];
    }
    
    return "Error: Could not parse usage from README.md";
  } catch (error) {
    return "Error: Could not read README.md";
  }
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const RESET = "\x1b[0m";
const SUCCESS = `${GREEN}✓${RESET}`;
const FAILURE = `${RED}✗${RESET}`;

async function printHelp(): Promise<void> {
  const USAGE = await loadUsageFromReadme();
  
  const colorized = USAGE.replace(
    /^(MCP Check.*?)$/m,
    `${BLUE}$1${RESET}`,
  )
    .replace(/^(Requirements:|Usage:|Arguments:|Examples:)/gm, `${BLUE}$1${RESET}`)
    .replace(/Common models:/g, `${YELLOW}Common models:${RESET}`)
    .replace(/^(\s*# .*?)$/gm, `${GREEN}$1${RESET}`);

  console.log(`\n${colorized}`);
}

interface MCPServer {
  label: string;
  url: string;
  headers?: Record<string, string>;
}

interface Config {
  message: string;
  servers: MCPServer[];
  expectations: string[];
  runs: number;
  concurrency: number;
  orgId: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  endpoint: string;
  customHeaders: Record<string, string>;
  mcpDiscovery?: string;
  serverList?: string;
}

interface RunOutcome {
  run: number;
  httpStatus: number;
  pass: boolean;
  logFile?: string;
  error?: string;
  responseBody?: string;
}

interface ExpectationCheck {
  expectation: string;
  found: boolean;
}

function buildPayload(message: string, servers: MCPServer[], model: string): string {
  const payload = {
    model,
    messages: [
      {
        role: "user",
        content: message,
      },
    ],
    temperature: 0.6,
    max_completion_tokens: 4096,
    top_p: 1,
    stop: null,
    stream: false,
    tools: servers.map((server) => ({
      type: "mcp",
      server_label: server.label,
      server_url: server.url,
      headers: server.headers || {},
    })),
    tool_choice: "auto",
  };
  return JSON.stringify(payload);
}

function printCurlTemplate(
  payload: string,
  url: string,
  customHeaders: Record<string, string>,
): void {
  const prettyPayload = JSON.stringify(JSON.parse(payload), null, 2)
    .split("\n")
    .map((line, idx) => (idx === 0 ? line : `    ${line}`))
    .join("\n");

  console.log(`\n${BLUE}Executing curl command:${RESET}\n`);
  console.log(`curl \\`);
  console.log(`  -X POST ${url} \\`);
  console.log(`  -H "Content-Type: application/json" \\`);
  console.log(`  -H "Authorization: Bearer \${GROQ_API_KEY}" \\`);
  
  for (const [key, value] of Object.entries(customHeaders)) {
    console.log(`  -H "${key}: ${value}" \\`);
  }
  
  console.log(`  -d '${prettyPayload}'`);
  console.log();
}

function extractAnswer(responseBody: string): string {
  try {
    const response = JSON.parse(responseBody);

    // Support both chat completions and responses API formats
    let text = "";
    
    if (response.choices && response.choices.length > 0) {
      // Chat completions format
      const lastChoice = response.choices[response.choices.length - 1];
      text = lastChoice.message?.content || "";
    } else if (response.output) {
      // Responses API format
      const outputs = response.output || [];
      const assistantMessages = outputs.filter(
        (item: any) => item.type === "message" && item.role === "assistant",
      );

      if (assistantMessages.length === 0) {
        return "";
      }

      const lastMessage = assistantMessages[assistantMessages.length - 1];
      const content = lastMessage.content || [];

      const outputText = content.find((item: any) => item.type === "output_text");
      if (!outputText || !outputText.text) {
        return "";
      }

      text = outputText.text;
    }

    if (!text) return "";

    // Extract answer block from the text
    const matches = Array.from(text.matchAll(/<answer>([\s\S]*?)<\/answer>/gi));
    if (matches.length === 0) return "";

    return matches[matches.length - 1][1].trim();
  } catch (error) {
    return "";
  }
}

function normalizeForComparison(text: string): string {
  return (
    text
      .toLowerCase()
      // Normalize Unicode to decomposed form then recompose (handles accents, etc.)
      .normalize("NFKD")
      // Replace all hyphen-like characters with regular hyphen
      .replace(
        /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/g,
        "-",
      )
      // Replace all quote-like characters with regular quotes
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'") // single quotes
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"') // double quotes
      // Normalize whitespace (multiple spaces to single space, trim)
      .replace(/\s+/g, " ")
      .trim()
  );
}

function checkExpectations(
  answer: string,
  expectations: string[],
): { allFound: boolean; checks: ExpectationCheck[] } {
  const normalizedAnswer = normalizeForComparison(answer);

  const checks: ExpectationCheck[] = expectations.map((exp) => ({
    expectation: exp,
    found: normalizedAnswer.includes(normalizeForComparison(exp)),
  }));
  return {
    allFound: checks.every((c) => c.found),
    checks,
  };
}

async function runOnce(
  config: Config,
  runNumber?: number,
): Promise<RunOutcome> {
  if (config.mcpDiscovery) {
    return runOnceMcpDiscovery(config, runNumber);
  }

  const payload = buildPayload(config.message, config.servers, config.model);
  const url = `${config.baseUrl}${config.endpoint}`;

  try {
    const curlArgs = [
      "curl",
      "-sS",
      "-X",
      "POST",
      url,
      "-H",
      "Content-Type: application/json",
      "-H",
      `Authorization: Bearer ${config.apiKey}`,
    ];

    for (const [key, value] of Object.entries(config.customHeaders)) {
      curlArgs.push("-H", `${key}: ${value}`);
    }

    curlArgs.push("-d", payload, "-w", "\nCURL_HTTP_CODE:%{http_code}\n");

    const proc = Bun.spawn(curlArgs, {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const chunks: Uint8Array[] = [];
    const reader = proc.stdout.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    await proc.exited;

    const output = Buffer.concat(chunks).toString();

    // Extract HTTP status from sentinel
    const statusMatch = output.match(/CURL_HTTP_CODE:(\d{3})\s*$/);
    const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : 0;

    // Remove sentinel from response body
    const responseBody = output.replace(/\nCURL_HTTP_CODE:\d{3}\s*$/, "");

    // Determine pass/fail
    let pass = false;
    const answer = extractAnswer(responseBody);

    if (config.expectations.length > 0) {
      // If expectations are provided, answer block must exist and contain all expectations
      if (!answer) {
        pass = false; // No answer block found
      } else {
        const { allFound } = checkExpectations(answer, config.expectations);
        pass = allFound;
      }
    } else {
      // If no expectations, just check HTTP status
      pass = httpStatus >= 200 && httpStatus < 300;
    }

    return {
      run: runNumber || 1,
      httpStatus,
      pass,
      responseBody,
    };
  } catch (error) {
    return {
      run: runNumber || 1,
      httpStatus: 0,
      pass: false,
      error: `Error executing curl: ${error}`,
    };
  }
}

let poolDaemonProcess: any = null;
const POOL_PORT = 7357;
const POOL_URL = `http://localhost:${POOL_PORT}`;

async function ensurePoolDaemon(serverList: string, replicas: number = 20): Promise<void> {
  // Check if pool is already running
  try {
    const response = await fetch(`${POOL_URL}/status`);
    if (response.ok) {
      console.error(`Pool daemon already running on port ${POOL_PORT}`);
      return;
    }
  } catch {
    // Pool not running, start it
  }

  console.error(`Starting pool daemon with ${replicas} replicas per server...`);
  
  poolDaemonProcess = Bun.spawn([
    "bunx",
    "mcp-discovery",
    "pool",
    "-s",
    serverList,
    "--replicas",
    String(replicas),
    "--port",
    String(POOL_PORT),
  ], {
    stdout: "inherit",
    stderr: "inherit",
  });

  // Wait for pool to be ready
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const response = await fetch(`${POOL_URL}/status`);
      if (response.ok) {
        console.error(`Pool daemon ready\n`);
        return;
      }
    } catch {
      // Keep waiting
    }
  }

  throw new Error("Pool daemon failed to start within 30 seconds");
}

async function shutdownPoolDaemon(): Promise<void> {
  if (!poolDaemonProcess) return;

  try {
    await fetch(`${POOL_URL}/shutdown`, { method: "POST" });
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch {
    // Ignore
  }

  poolDaemonProcess.kill();
  poolDaemonProcess = null;
}

async function runOnceMcpDiscovery(
  config: Config,
  runNumber?: number,
): Promise<RunOutcome> {
  try {
    const args = [
      "bunx",
      "mcp-discovery",
      config.mcpDiscovery!,
      "-p",
      config.message,
      "-m",
      config.model,
    ];

    // If serverList is provided, pass it through
    // The pool will have been started with the same server list
    if (config.serverList) {
      args.push("-s", config.serverList);
    }

    // Add --via-pool flag if running benchmark mode (runs > 1)
    if (config.runs > 1) {
      args.push("--via-pool", POOL_URL);
    }

    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
    });

    const chunks: Uint8Array[] = [];
    const reader = proc.stdout.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const exitCode = await proc.exited;
    const responseBody = Buffer.concat(chunks).toString();

    // Determine pass/fail
    let pass = false;
    const answer = extractAnswer(responseBody);

    if (config.expectations.length > 0) {
      if (!answer) {
        pass = false;
      } else {
        const { allFound } = checkExpectations(answer, config.expectations);
        pass = allFound;
      }
    } else {
      // If no expectations, check exit code
      pass = exitCode === 0;
    }

    return {
      run: runNumber || 1,
      httpStatus: exitCode === 0 ? 200 : 500,
      pass,
      responseBody,
    };
  } catch (error) {
    return {
      run: runNumber || 1,
      httpStatus: 0,
      pass: false,
      error: `Error executing mcp-discovery: ${error}`,
    };
  }
}

async function singleRun(config: Config): Promise<void> {
  if (config.mcpDiscovery) {
    console.log(`\n${BLUE}Executing mcp-discovery command:${RESET}\n`);
    const serverArg = config.serverList ? ` -s ${config.serverList}` : '';
    console.log(`bunx mcp-discovery ${config.mcpDiscovery} -p "${config.message}" -m ${config.model}${serverArg}\n`);
  } else {
    const payload = buildPayload(config.message, config.servers, config.model);
    const url = `${config.baseUrl}${config.endpoint}`;
    printCurlTemplate(payload, url, config.customHeaders);
  }

  if (config.expectations.length === 0) {
    console.log(
      `${YELLOW}Note: No expectations provided. Pass/fail based on ${config.mcpDiscovery ? "exit code" : "HTTP status"} only.${RESET}\n`,
    );
  }

  const result = await runOnce(config);

  console.log("═".repeat(60));
  console.log(`${BLUE}Response:${RESET}\n`);
  console.log(result.responseBody || "(no response)");
  console.log("\n" + "═".repeat(60));
  console.log(`\n${BLUE}HTTP Status:${RESET} ${result.httpStatus}\n`);

  const answer = extractAnswer(result.responseBody || "");
  if (answer) {
    console.log(`${BLUE}Answer Block:${RESET}\n${answer}\n`);
  } else {
    console.log(
      `${YELLOW}Warning: No <answer> block found in response${RESET}\n`,
    );
  }

  if (config.expectations.length > 0) {
    if (!answer) {
      console.log(`${RED}FAIL${RESET} - No answer block found\n`);
      process.exit(1);
    }

    const { allFound, checks } = checkExpectations(answer, config.expectations);

    console.log(`${BLUE}Expectations:${RESET}\n`);
    for (const check of checks) {
      const status = check.found ? SUCCESS : FAILURE;
      console.log(`  ${status} "${check.expectation}"`);
    }

    console.log();
    if (allFound) {
      console.log(`${GREEN}PASS${RESET} - All expectations found\n`);
      process.exit(0);
    } else {
      console.log(`${RED}FAIL${RESET} - Some expectations missing\n`);
      process.exit(1);
    }
  } else {
    if (result.httpStatus >= 200 && result.httpStatus < 300) {
      console.log(`${GREEN}PASS${RESET} - HTTP 2xx status\n`);
      process.exit(0);
    } else {
      console.log(`${RED}FAIL${RESET} - Non-2xx status\n`);
      process.exit(1);
    }
  }
}

async function benchmarkRun(config: Config): Promise<void> {
  // Start pool daemon if using mcp-discovery
  if (config.mcpDiscovery && config.serverList) {
    const replicas = Math.max(config.concurrency, 20);
    await ensurePoolDaemon(config.serverList, replicas);
  }

  const tempDir = await mkdtemp(join(tmpdir(), "mcp-check-"));
  const successDir = join(tempDir, "success");
  const failDir = join(tempDir, "fail");

  await mkdir(successDir);
  await mkdir(failDir);

  console.log(`\n📁 Logs directory: ${tempDir}\n`);

  if (config.mcpDiscovery) {
    console.log(`\n${BLUE}Using mcp-discovery with pool:${RESET}\n`);
    const serverArg = config.serverList ? ` -s ${config.serverList}` : '';
    console.log(`  Strategy: ${config.mcpDiscovery}`);
    console.log(`  Model: ${config.model}`);
    console.log(`  Servers: ${config.serverList || "(none)"}`);
    console.log(`  Pool: ${POOL_URL}\n`);
  } else {
    const payload = buildPayload(config.message, config.servers, config.model);
    const url = `${config.baseUrl}${config.endpoint}`;
    printCurlTemplate(payload, url, config.customHeaders);
  }

  if (config.expectations.length === 0) {
    console.log(
      `${YELLOW}Note: No expectations provided. Pass/fail based on ${config.mcpDiscovery ? "exit code" : "HTTP status"} only.${RESET}\n`,
    );
  } else {
    console.log(
      `${BLUE}Expectations:${RESET} ${config.expectations.join(", ")}\n`,
    );
  }

  console.log(
    `Running ${config.runs} times (concurrency: ${config.concurrency})...\n`,
  );

  const results: RunOutcome[] = [];
  let spinnerFrame = 0;
  let lastOutputTime = Date.now();
  let spinnerInterval: Timer | null = null;

  const updateSpinner = () => {
    const timeSinceOutput = Date.now() - lastOutputTime;
    const frame =
      timeSinceOutput > 2000
        ? "⏸"
        : SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];

    const passes = results.filter((r) => r.pass).length;
    const fails = results.filter((r) => !r.pass).length;

    process.stdout.write(
      `\r${frame} [${results.length}/${config.runs}] ${SUCCESS}${passes} ${FAILURE}${fails}`,
    );
    spinnerFrame++;
  };

  spinnerInterval = setInterval(updateSpinner, 80);

  const runTest = async (i: number) => {
    const filename = `run-${i.toString().padStart(3, "0")}.log`;

    try {
      const result = await runOnce(config, i);
      lastOutputTime = Date.now();

      // Build log content
      const logLines = [
        result.responseBody || "(no response)",
        "",
        `status: ${result.httpStatus}`,
        `pass: ${result.pass}`,
      ];

      const answer = extractAnswer(result.responseBody || "");

      if (answer) {
        logLines.push(`answer_block: ${answer.replace(/\n/g, "\\n")}`);
      } else {
        logLines.push(`answer_block: (no answer block found)`);
      }

      if (config.expectations.length > 0) {
        const { checks } = checkExpectations(answer, config.expectations);
        const missing = checks
          .filter((c) => !c.found)
          .map((c) => c.expectation);

        logLines.push(`expectations: ${config.expectations.join(",")}`);
        logLines.push(`missing: ${missing.join(",")}`);
      }

      logLines.push(`servers: ${config.servers.map((s) => `${s.label}:${s.url}`).join(",")}`);

      const targetDir = result.pass ? successDir : failDir;
      const logFile = join(targetDir, filename);
      await Bun.write(logFile, logLines.join("\n"));

      results.push({ ...result, logFile });
    } catch (error) {
      const logFile = join(failDir, filename);
      await Bun.write(logFile, `Error running test: ${error}\n`);
      results.push({
        run: i,
        httpStatus: 0,
        pass: false,
        logFile,
        error: String(error),
      });
    }
  };

  const workers: Promise<void>[] = [];
  let nextRun = 1;

  for (let i = 0; i < config.concurrency; i++) {
    workers.push(
      (async () => {
        while (nextRun <= config.runs) {
          const runNumber = nextRun++;
          await runTest(runNumber);
        }
      })(),
    );
  }

  await Promise.all(workers);

  if (spinnerInterval) {
    clearInterval(spinnerInterval);
  }

  // Clear the progress line and show full status grid
  process.stdout.write("\r\x1b[K");

  const terminalWidth = process.stdout.columns || 80;
  const allStatuses = results
    .sort((a, b) => a.run - b.run)
    .map((r) => (r.pass ? SUCCESS : FAILURE));

  const lines: string[] = [];
  for (let i = 0; i < allStatuses.length; i += terminalWidth) {
    lines.push(allStatuses.slice(i, i + terminalWidth).join(""));
  }

  console.log(lines.join("\n") + "\n");

  const passes = results.filter((r) => r.pass).length;
  const fails = results.filter((r) => !r.pass).length;
  const passRate = ((passes / config.runs) * 100).toFixed(1);

  // Compress success logs
  if (passes > 0) {
    try {
      const tarFile = join(tempDir, "success.tar.gz");
      const tarProc = Bun.spawn(
        ["tar", "-czf", tarFile, "-C", tempDir, "success"],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      await tarProc.exited;

      await Bun.spawn(["rm", "-rf", successDir], {
        stdout: "pipe",
        stderr: "pipe",
      }).exited;
    } catch (error) {
      console.log(`${YELLOW}Warning: Failed to compress success logs${RESET}`);
    }
  }

  console.log("═".repeat(60));
  console.log(`\n📊 Results:\n`);
  console.log(`   Total runs:    ${config.runs}`);
  console.log(`   ${SUCCESS} Passes:      ${GREEN}${passes}${RESET}`);
  console.log(`   ${FAILURE} Failures:    ${RED}${fails}${RESET}`);
  console.log(`   Pass rate:     ${passRate}%`);

  console.log(`\n📁 Logs:`);
  if (passes > 0) {
    console.log(
      `   ${GREEN}✓${RESET} Success logs: ${join(tempDir, "success.tar.gz")}`,
    );
  }
  if (fails > 0) {
    console.log(`   ${RED}✗${RESET} Failed logs:  ${failDir}`);
  }

  console.log("\n" + "═".repeat(60) + "\n");

  // Shutdown pool daemon if we started it
  if (config.mcpDiscovery && config.serverList) {
    await shutdownPoolDaemon();
  }

  process.exit(fails > 0 ? 1 : 0);
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      p: { type: "string", short: "p" },
      m: { type: "string", short: "m" },
      s: { type: "string", short: "s" },
      S: { type: "string", short: "S", multiple: true },
      x: { type: "string", short: "x", multiple: true },
      n: { type: "string", short: "n", default: "1" },
      c: { type: "string", short: "c", default: "1" },
      prod: { type: "boolean" },
      "base-url": { type: "string" },
      endpoint: { type: "string", default: "/api/openai/v1/chat/completions" },
      header: { type: "string", multiple: true },
      "mcp-discovery": { type: "string" },
      help: { type: "boolean" },
    },
    strict: false,
  });

  if (values.help) {
    await printHelp();
    process.exit(0);
  }

  const mcpDiscovery = values["mcp-discovery"] as string | undefined;

  // Validate incompatible options with --mcp-discovery
  if (mcpDiscovery) {
    const incompatibleOptions = [];
    if (values.S && (values.S as string[]).length > 0) incompatibleOptions.push("-S");
    if (values.prod) incompatibleOptions.push("--prod");
    if (values["base-url"]) incompatibleOptions.push("--base-url");
    if (values.endpoint !== "/api/openai/v1/chat/completions") incompatibleOptions.push("--endpoint");
    if (values.header && (values.header as string[]).length > 0) incompatibleOptions.push("--header");

    if (incompatibleOptions.length > 0) {
      console.error(
        `${RED}Error: ${incompatibleOptions.join(", ")} cannot be used with --mcp-discovery${RESET}\n`,
      );
      process.exit(1);
    }
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey && !mcpDiscovery) {
    console.error(`${RED}Error: GROQ_API_KEY must be set.${RESET}`);
    process.exit(1);
  }

  const message = values.p as string | undefined;
  const serverSpecs = (values.S as string[] | undefined) || [];
  const serverList = values.s as string | undefined;
  const model = values.m as string | undefined;

  if (!message || !model) {
    console.error(
      `${RED}Error: -p (prompt) and -m (model) are required.${RESET}\n`,
    );
    console.error(`Run with --help for usage information.\n`);
    process.exit(1);
  }

  const servers: MCPServer[] = serverSpecs.map((spec) => {
    const colonIndex = spec.indexOf(":");
    if (colonIndex === -1) {
      console.error(
        `${RED}Error: Server spec must be in format "label:url", got: ${spec}${RESET}`,
      );
      process.exit(1);
    }
    const label = spec.substring(0, colonIndex);
    const url = spec.substring(colonIndex + 1);
    return { label, url };
  });

  const customHeaders: Record<string, string> = {};
  const headerSpecs = (values.header as string[] | undefined) || [];
  for (const header of headerSpecs) {
    const colonIndex = header.indexOf(":");
    if (colonIndex === -1) {
      console.error(
        `${RED}Error: Header must be in format "Key: Value", got: ${header}${RESET}`,
      );
      process.exit(1);
    }
    const key = header.substring(0, colonIndex).trim();
    const value = header.substring(colonIndex + 1).trim();
    customHeaders[key] = value;
  }

  const expectations = (values.x as string[] | undefined) || [];
  const runs = parseInt(values.n as string, 10);
  const concurrency = parseInt(values.c as string, 10);

  if (isNaN(runs) || runs < 1) {
    console.error(`${RED}Error: -n must be a positive integer${RESET}`);
    process.exit(1);
  }

  if (isNaN(concurrency) || concurrency < 1) {
    console.error(`${RED}Error: -c must be a positive integer${RESET}`);
    process.exit(1);
  }

  const baseUrl =
    (values["base-url"] as string | undefined) ||
    (values.prod ? "https://api.groq.com" : "http://localhost:8000");

  const config: Config = {
    message,
    servers,
    expectations,
    runs,
    concurrency,
    orgId: "",
    apiKey,
    model,
    baseUrl,
    endpoint: values.endpoint as string,
    customHeaders,
    mcpDiscovery,
    serverList,
  };

  // Pre-flight check for mcp-discovery
  if (mcpDiscovery) {
    console.log(`${BLUE}Checking mcp-discovery availability...${RESET}`);
    try {
      const proc = Bun.spawn(["bunx", "mcp-discovery@latest", "--help"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      
      const exitCode = await proc.exited;
      
      if (exitCode !== 0) {
        console.error(`${RED}Error: Failed to run mcp-discovery. Please ensure it's available.${RESET}`);
        process.exit(1);
      }
      
      console.log(`${GREEN}✓${RESET} mcp-discovery ready\n`);
    } catch (error) {
      console.error(`${RED}Error: Failed to run mcp-discovery: ${error}${RESET}`);
      process.exit(1);
    }
  }

  if (runs === 1) {
    await singleRun(config);
  } else {
    await benchmarkRun(config);
  }
}

main().catch((error) => {
  console.error(`${RED}Error:${RESET}`, error);
  process.exit(1);
});
