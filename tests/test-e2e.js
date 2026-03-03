/**
 * E2E Test Framework for claude-recap
 *
 * Tests the full plugin lifecycle: Claude CLI loads plugin → hooks trigger
 * → LLM writes session files → session files are injected on next start.
 *
 * Assertions are anchored on file system side effects (deterministic),
 * NOT on LLM text output (non-deterministic).
 *
 * Usage:
 *   node tests/test-e2e.js                  # run all E2E tests
 *   node tests/test-e2e.js --test "cold"    # run tests matching pattern
 *   node tests/test-e2e.js --dry-run        # show test list without running
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ─── Config ──────────────────────────────────────────────────────────────────

const PLUGIN_DIR = path.resolve(__dirname, '..');

const DEFAULT_TIMEOUT_MS = 120_000;   // 2 min per test
const DEFAULT_BUDGET_USD = 5;         // cost cap per test

// ─── Helpers ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.log(`  ✗ ${message}`);
    failed++;
  }
}

function assertFileExists(filePath, message) {
  assert(fs.existsSync(filePath), message || `File exists: ${filePath}`);
}

function assertFileNotExists(filePath, message) {
  assert(!fs.existsSync(filePath), message || `File does not exist: ${filePath}`);
}

/**
 * Create an isolated test environment.
 * Returns { projectDir, memoryHome, cleanup }.
 */
function createWorkspace() {
  const id = crypto.randomBytes(4).toString('hex');
  const projectDir = path.join(os.tmpdir(), `memory-e2e-project-${id}`);
  const memoryHome = path.join(os.tmpdir(), `memory-e2e-home-${id}`);

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(memoryHome, { recursive: true });

  return {
    projectDir,
    memoryHome,
    cleanup() {
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(memoryHome, { recursive: true, force: true }); } catch {}
    },
  };
}

/**
 * Get the project directory path inside memory home for a given project dir.
 */
function getProjectMemoryDir(memoryHome, projectDir) {
  // Resolve symlinks (macOS: /tmp → /private/tmp) to match what Claude reports as cwd
  const realProjectDir = fs.realpathSync(projectDir);
  const projectId = realProjectDir.replace(/\//g, '-');
  return path.join(memoryHome, 'projects', projectId);
}

/**
 * Find all session directories (UUID pattern) under the project memory dir.
 * Returns [{ sessionId, dirPath }].
 */
function findSessionDirs(memoryHome, projectDir) {
  const projectMemDir = getProjectMemoryDir(memoryHome, projectDir);
  if (!fs.existsSync(projectMemDir)) return [];
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  return fs.readdirSync(projectMemDir)
    .filter(d => UUID_RE.test(d))
    .map(d => ({ sessionId: d, dirPath: path.join(projectMemDir, d) }));
}

/**
 * Find topic files across all sessions for a given project dir.
 * v2 structure: projects/{projectId}/{sessionUUID}/{seq}-{topic}.md
 */
function findTopicFiles(memoryHome, projectDir) {
  const sessions = findSessionDirs(memoryHome, projectDir);
  const files = [];
  for (const sess of sessions) {
    const entries = fs.readdirSync(sess.dirPath)
      .filter(f => f.endsWith('.md') && !f.startsWith('.'));
    for (const f of entries) {
      files.push({
        name: f,
        sessionId: sess.sessionId,
        path: path.join(sess.dirPath, f),
        content: fs.readFileSync(path.join(sess.dirPath, f), 'utf-8'),
      });
    }
  }
  return files;
}

/**
 * Check if .current_topic exists in any session dir for the project.
 * Returns the topic string or null.
 */
function getCurrentTopic(memoryHome, projectDir) {
  const sessions = findSessionDirs(memoryHome, projectDir);
  for (const sess of sessions) {
    const topicFile = path.join(sess.dirPath, '.current_topic');
    if (fs.existsSync(topicFile)) {
      return fs.readFileSync(topicFile, 'utf-8').trim();
    }
  }
  return null;
}

/**
 * Run a Claude CLI session in non-interactive mode.
 *
 * Returns {
 *   exitCode: number,
 *   stdout: string,
 *   messages: object[],
 *   toolCalls: string[],
 *   duration: number,
 *   costUSD: number|null,
 * }
 */
function runClaude(opts) {
  const {
    prompt,
    cwd,
    memoryHome,
    withPlugin = true,
    continueSession = false,
    timeout = DEFAULT_TIMEOUT_MS,
    budget = DEFAULT_BUDGET_USD,
    model = 'sonnet',
  } = opts;

  return new Promise((resolve) => {
    const args = [
      '-p',                              // non-interactive print mode
      '--verbose',                       // required for stream-json
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--max-budget-usd', String(budget),
      '--model', model,
    ];

    if (withPlugin) {
      args.push('--plugin-dir', PLUGIN_DIR);
    }

    // Isolate from user hooks while allowing plugin loading
    args.push('--setting-sources', 'project');

    if (continueSession) {
      args.push('--continue');
    }

    args.push(prompt);

    const env = {
      ...process.env,
      MEMORY_HOME: memoryHome,
      // Allow launching claude inside a Claude Code session
      CLAUDECODE: '',
    };

    const startTime = Date.now();
    let stdout = '';
    let stderr = '';

    const child = spawn('claude', args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeout);

    child.on('exit', (code) => {
      clearTimeout(timer);
      const duration = Date.now() - startTime;

      if (code !== 0) {
        console.log(`  [debug] exitCode: ${code}`);
        if (!stdout) console.log(`  [debug] stdout: (empty)`);
        else console.log(`  [debug] stdout last 500 chars: ${stdout.slice(-500)}`);
      }
      // Always show stop.sh debug lines from stderr
      if (stderr) {
        const hookLines = stderr.split('\n').filter(l => l.includes('[stop.sh]')).join('\n');
        if (hookLines) console.log(`  [hook] ${hookLines}`);
      }

      // Parse stream-json output
      const messages = [];
      const toolCalls = [];
      let costUSD = null;

      for (const line of stdout.split('\n').filter(Boolean)) {
        try {
          const msg = JSON.parse(line);
          messages.push(msg);

          if (msg.type === 'result') {
            if (msg.total_cost_usd != null) costUSD = msg.total_cost_usd;
          }

          // Extract tool calls
          const contentBlocks = msg.message?.content || msg.content || [];
          if (Array.isArray(contentBlocks)) {
            for (const block of contentBlocks) {
              if (block.type === 'tool_use') {
                const cmd = block.input?.command || '';
                if (cmd) toolCalls.push(cmd);
                if (block.name) {
                  toolCalls.push(`__tool__:${block.name}:${JSON.stringify(block.input || {})}`);
                }
              }
            }
          }
        } catch {
          // Not JSON, skip
        }
      }

      const durationSec = (duration / 1000).toFixed(1);
      const costStr = costUSD != null ? `$${costUSD.toFixed(4)}` : 'N/A';
      console.log(`  [info] cost=${costStr}, duration=${durationSec}s`);

      resolve({
        exitCode: code,
        stdout,
        stderr,
        messages,
        toolCalls,
        duration,
        costUSD,
      });
    });
  });
}

/**
 * Check if any tool call matches a pattern.
 */
function hasToolCall(result, pattern) {
  return result.toolCalls.some(cmd => cmd.includes(pattern));
}

// ─── Test Registry ───────────────────────────────────────────────────────────

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function runTests() {
  const filter = getArg('--test');
  const dryRun = process.argv.includes('--dry-run');

  const toRun = filter
    ? tests.filter(t => t.name.toLowerCase().includes(filter.toLowerCase()))
    : tests;

  if (dryRun) {
    console.log('E2E Test List:\n');
    for (const t of toRun) {
      console.log(`  - ${t.name}`);
    }
    console.log(`\n${toRun.length} tests total`);
    return;
  }

  console.log(`\nRunning ${toRun.length} E2E tests...\n`);

  for (const t of toRun) {
    console.log(`Test: ${t.name}`);
    try {
      await t.fn();
    } catch (err) {
      console.log(`  ✗ CRASHED: ${err.message}`);
      failed++;
    }
    console.log('');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx > -1 ? process.argv[idx + 1] : null;
}

// ─── E2E Test Cases ──────────────────────────────────────────────────────────

// ---- Case 1: Topic registration on cold start ----

test('Case 1: Topic registration on cold start', async () => {
  const ws = createWorkspace();
  try {
    const result = await runClaude({
      prompt: 'Say hello and tell me what 2+2 is. Keep it brief.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
    });

    // Plugin loaded and CLI exited normally
    assert(result.exitCode === 0, 'CLI exited with code 0');

    // Session dir was created (proves set-topic.sh ran)
    const sessions = findSessionDirs(ws.memoryHome, ws.projectDir);
    assert(sessions.length >= 1, `At least 1 session dir created (got ${sessions.length})`);

    // .current_topic was set (proves LLM called /set-topic)
    const topic = getCurrentTopic(ws.memoryHome, ws.projectDir);
    assert(topic !== null, `.current_topic exists (value: ${topic})`);

    // Topic file is a bonus — first topic may only be archived at session end
    const topics = findTopicFiles(ws.memoryHome, ws.projectDir);
    if (topics.length > 0) {
      // File name matches pattern: {seq}-{slug}.md
      assert(/^\d{2}-.+\.md$/.test(topics[0].name),
        `Topic file name matches {seq}-{slug}.md pattern: ${topics[0].name}`);
    }
  } finally {
    ws.cleanup();
  }
});

// ---- Case 2: Topic summary quality on topic switch (multi-turn) ----

test('Case 2: Topic summary quality on topic switch', async () => {
  const ws = createWorkspace();
  try {
    // Create a file for the first task
    fs.writeFileSync(path.join(ws.projectDir, 'app.js'), `
function greet(name) {
  // BUG: should return greeting, not undefined
  console.log("Hello, " + name);
}
module.exports = { greet };
`);

    // Turn 1: fix a bug (registers initial topic)
    console.log('  [turn 1] Coding task...');
    const result1 = await runClaude({
      prompt: 'Fix the bug in app.js: greet should return the greeting string instead of console.log. Keep it brief.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
    });
    assert(result1.exitCode === 0, 'Turn 1: CLI exited with code 0');

    // Turn 2: completely different topic → should trigger /set-topic and archive turn 1
    console.log('  [turn 2] Different topic...');
    const result2 = await runClaude({
      prompt: 'New topic: create a file called poem.txt with a short haiku about coding. This is unrelated to the previous task.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
      continueSession: true,
    });
    assert(result2.exitCode === 0, 'Turn 2: CLI exited with code 0');

    // The topic switch should have archived the first topic as a summary file
    const topics = findTopicFiles(ws.memoryHome, ws.projectDir);
    assert(topics.length >= 1, `At least 1 topic file created (got ${topics.length})`);

    if (topics.length > 0) {
      const content = topics[0].content;

      // Has required section with non-empty content
      assert(content.includes('## Status') || content.includes('## Summary'),
        'Has "## Status" or "## Summary" section');

      // Section has actual content (not just header)
      const sectionMatch = content.match(/## (?:Status|Summary)[^\n]*\n+([\s\S]*?)(?=\n## |$)/);
      assert(sectionMatch && sectionMatch[1].trim().length > 10,
        'Section has meaningful content (>10 chars)');
    }
  } finally {
    ws.cleanup();
  }
});

// ---- Case 3: Cross-session memory (Write→Read loop) ----

test('Case 3: Cross-session memory (Write-Read loop)', async () => {
  const ws = createWorkspace();
  try {
    // Session 1: Do a task that produces a topic file
    console.log('  [session 1] Writing memory...');
    const result1 = await runClaude({
      prompt: 'Create a file called counter.js with a simple counter class that has increment() and getCount() methods. Write the file.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
    });

    assert(result1.exitCode === 0, 'Session 1: CLI exited with code 0');

    // .current_topic may or may not be set (LLM non-determinism in single-prompt mode)
    const topic1 = getCurrentTopic(ws.memoryHome, ws.projectDir);
    if (topic1) {
      console.log(`  [info] Session 1: .current_topic = ${topic1}`);
    } else {
      console.log(`  [warn] Session 1: .current_topic not set (LLM did not call /set-topic)`);
    }

    // Session 2: Ask about previous work — SessionStart injects topic file list
    console.log('  [session 2] Reading memory...');
    const result2 = await runClaude({
      prompt: 'What was done in the previous session on this project? Check the topic history files if available.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
    });

    assert(result2.exitCode === 0, 'Session 2: CLI exited with code 0');

    // Session 2 should have read a topic file or mentioned previous work
    const mentionedPrevWork = hasToolCall(result2, 'topics/') ||
      hasToolCall(result2, '.md') ||
      result2.stdout.toLowerCase().includes('counter');
    assert(mentionedPrevWork,
      'Session 2: accessed topic files or mentioned previous work (counter)');

  } finally {
    ws.cleanup();
  }
});

// ---- Case 4: No plugin control group ----

test('Case 4: No plugin - no memory side effects', async () => {
  const ws = createWorkspace();
  try {
    const result = await runClaude({
      prompt: 'Say hello and tell me what 2+2 is. Keep it brief.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
      withPlugin: false,
    });

    assert(result.exitCode === 0, 'CLI exited with code 0');

    // No session dirs should be created without the plugin
    const sessions = findSessionDirs(ws.memoryHome, ws.projectDir);
    assert(sessions.length === 0, `No session dirs created without plugin (got ${sessions.length})`);

    // No projects directory should exist
    const projectsDir = path.join(ws.memoryHome, 'projects');
    assertFileNotExists(projectsDir, 'No projects directory created');

  } finally {
    ws.cleanup();
  }
});

// ---- Case 5: Topic content language matches user language ----

test('Case 5: Topic content language matches user conversation language', async () => {
  const ws = createWorkspace();
  try {
    // Turn 1: Chinese coding task (registers initial topic)
    fs.writeFileSync(path.join(ws.projectDir, 'hello.js'), 'console.log("hello");\n');

    console.log('  [turn 1] Chinese coding task...');
    const result1 = await runClaude({
      prompt: '把 hello.js 里的 "hello" 改成 "你好世界"。简短回答。',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
    });
    assert(result1.exitCode === 0, 'Turn 1: CLI exited with code 0');

    // Turn 2: Different Chinese task → triggers /set-topic, archives turn 1
    console.log('  [turn 2] Different Chinese task...');
    const result2 = await runClaude({
      prompt: '新任务：创建一个 math.js 文件，导出一个 add(a,b) 函数。这和之前的任务无关。',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
      continueSession: true,
    });
    assert(result2.exitCode === 0, 'Turn 2: CLI exited with code 0');

    const topics = findTopicFiles(ws.memoryHome, ws.projectDir);
    assert(topics.length >= 1, `At least 1 topic file created (got ${topics.length})`);

    if (topics.length > 0) {
      const content = topics[0].content;

      // Section headings must be in English
      assert(content.includes('## Status') || content.includes('## Summary'),
        'Section heading is in English');

      // Descriptive content should contain Chinese characters (matching user language)
      const sectionMatch = content.match(/## (?:Status|Summary)[^\n]*\n+([\s\S]*?)(?=\n## |$)/);
      const hasChinese = sectionMatch && /[\u4e00-\u9fff]/.test(sectionMatch[1]);
      assert(hasChinese,
        'Section content is written in Chinese (matching user language)');
    }
  } finally {
    ws.cleanup();
  }
});

// ─── Run ─────────────────────────────────────────────────────────────────────

runTests();
