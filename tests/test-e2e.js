/**
 * E2E Test Framework for agent-os-memory
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

// ---- Case 6: /remember end-to-end (write → inject on next session) ----

test('Case 6: /remember persists and injects on next session', async () => {
  const ws = createWorkspace();
  try {
    // Session 1: Use /remember to save a preference
    console.log('  [session 1] Saving preference via /remember...');
    const result1 = await runClaude({
      prompt: 'Please remember this preference for me: always use bun instead of npm. Use /remember to save it globally.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
    });

    assert(result1.exitCode === 0, 'Session 1: CLI exited with code 0');

    // Check REMEMBER.md was created
    const globalRemember = path.join(ws.memoryHome, 'REMEMBER.md');
    assertFileExists(globalRemember, 'Global REMEMBER.md created');

    if (fs.existsSync(globalRemember)) {
      const content = fs.readFileSync(globalRemember, 'utf-8');
      assert(content.toLowerCase().includes('bun'),
        'REMEMBER.md contains "bun" preference');
    }

    // Session 2: Check that preference is injected
    console.log('  [session 2] Checking preference injection...');
    const result2 = await runClaude({
      prompt: 'What preferences or things have I asked you to remember? Check the SessionStart context. Keep it brief.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
    });

    assert(result2.exitCode === 0, 'Session 2: CLI exited with code 0');

    // Session 2 should mention bun (injected from REMEMBER.md)
    const mentionsBun = result2.stdout.toLowerCase().includes('bun');
    assert(mentionsBun, 'Session 2: mentions "bun" from injected REMEMBER.md');

  } finally {
    ws.cleanup();
  }
});

// ---- Case 7: archive-pending delayed archival ----

test('Case 7: archive-pending archives unarchived topics', async () => {
  const ws = createWorkspace();
  try {
    // Session 1: Create a topic but don't trigger a topic switch
    // (the last topic in a session is often unarchived — archive-pending catches it)
    console.log('  [session 1] Creating task with single topic...');
    const result1 = await runClaude({
      prompt: 'Create a file called utils.js with a function capitalize(str) that capitalizes the first letter. Write the file.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
    });

    assert(result1.exitCode === 0, 'Session 1: CLI exited with code 0');

    // Check .current_topic was set
    const topic1 = getCurrentTopic(ws.memoryHome, ws.projectDir);
    if (topic1) {
      console.log(`  [info] Session 1: .current_topic = ${topic1}`);
    }

    // Count topic files before session 2
    const topicsBefore = findTopicFiles(ws.memoryHome, ws.projectDir);
    console.log(`  [info] Topic files before session 2: ${topicsBefore.length}`);

    // Session 2: New session triggers SessionStart → archive-pending runs in background
    // Give it a simple task and wait
    console.log('  [session 2] Triggering archive-pending via SessionStart...');
    const result2 = await runClaude({
      prompt: 'Say hello briefly.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
      timeout: 180_000, // extra time for archive-pending background process
    });

    assert(result2.exitCode === 0, 'Session 2: CLI exited with code 0');

    // Wait a moment for archive-pending background process
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Check if archive-pending created topic files
    const topicsAfter = findTopicFiles(ws.memoryHome, ws.projectDir);
    console.log(`  [info] Topic files after session 2: ${topicsAfter.length}`);

    // archive-pending should have archived the unarchived topic from session 1
    assert(topicsAfter.length > topicsBefore.length,
      `More topic files after session 2 (before: ${topicsBefore.length}, after: ${topicsAfter.length})`);

  } finally {
    ws.cleanup();
  }
});

// ---- Case 8: Compact cold-read recovery ----

test('Case 8: Compact cold-read recovery produces accurate summary', async () => {
  const ws = createWorkspace();
  try {
    // Session 1: Work on a coding task (establishes a topic with real JSONL)
    console.log('  [session 1] Coding task to establish topic + JSONL...');
    fs.writeFileSync(path.join(ws.projectDir, 'calc.js'), `
function add(a, b) { return a + b; }
function subtract(a, b) { return a - b; }
module.exports = { add, subtract };
`);

    const result1 = await runClaude({
      prompt: 'Add a multiply(a, b) function to calc.js. Write the file.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
    });

    assert(result1.exitCode === 0, 'Session 1: CLI exited with code 0');

    // Find the session directory and manually place .compacted marker
    const sessions = findSessionDirs(ws.memoryHome, ws.projectDir);
    assert(sessions.length >= 1, 'Session dir exists');

    if (sessions.length > 0) {
      const sessionDir = sessions[0].dirPath;
      const compactedFile = path.join(sessionDir, '.compacted');
      fs.writeFileSync(compactedFile, '');
      console.log(`  [info] Placed .compacted marker in ${sessions[0].sessionId}`);

      // Session 2: Different topic → triggers set-topic.sh → should cold-read
      console.log('  [session 2] Topic switch with .compacted marker...');
      const result2 = await runClaude({
        prompt: 'New topic: create a file called hello.txt with the text "hello world". This is completely unrelated to calc.js.',
        cwd: ws.projectDir,
        memoryHome: ws.memoryHome,
        continueSession: true,
        timeout: 180_000, // cold-read needs extra time
      });

      assert(result2.exitCode === 0, 'Session 2: CLI exited with code 0');

      // Check that a topic file was created (cold-read or fallback)
      const topics = findTopicFiles(ws.memoryHome, ws.projectDir);
      assert(topics.length >= 1, `At least 1 topic file created (got ${topics.length})`);

      if (topics.length > 0) {
        const content = topics[0].content;
        // Cold-read summary should mention the actual work (calc/multiply)
        const mentionsWork = content.toLowerCase().includes('calc') ||
          content.toLowerCase().includes('multiply') ||
          content.toLowerCase().includes('function');
        assert(mentionsWork,
          'Topic summary mentions actual work (calc/multiply/function)');
      }

      // .compacted should be removed after cold-read (set-topic.sh cleans it)
      const compactedExists = fs.existsSync(compactedFile);
      assert(!compactedExists, '.compacted marker removed after cold-read');
    }
  } finally {
    ws.cleanup();
  }
});

// ---- Case 9: /save-topic manual checkpoint ----

test('Case 9: /save-topic creates topic file without topic switch', async () => {
  const ws = createWorkspace();
  try {
    // Single session: work on something, then /save-topic
    console.log('  [session] Task + manual save...');
    fs.writeFileSync(path.join(ws.projectDir, 'app.js'), 'console.log("app");\n');

    const result = await runClaude({
      prompt: 'Read app.js and add a comment explaining what it does. Then use /save-topic to checkpoint progress.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
    });

    assert(result.exitCode === 0, 'CLI exited with code 0');

    // /save-topic should have created a topic file without needing a topic switch
    const topics = findTopicFiles(ws.memoryHome, ws.projectDir);
    assert(topics.length >= 1,
      `/save-topic created topic file (got ${topics.length})`);

    if (topics.length > 0) {
      assert(topics[0].content.includes('# Topic:'),
        'Topic file has "# Topic:" header');
    }
  } finally {
    ws.cleanup();
  }
});

// ---- Case 10: Multi-topic single session ----

test('Case 10: Multiple topic switches in single session', async () => {
  const ws = createWorkspace();
  try {
    // Turn 1: First topic
    console.log('  [turn 1] First topic...');
    fs.writeFileSync(path.join(ws.projectDir, 'a.js'), 'const a = 1;\n');
    const result1 = await runClaude({
      prompt: 'Read a.js and add a JSDoc comment to it. Keep it brief.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
    });
    assert(result1.exitCode === 0, 'Turn 1: CLI exited with code 0');

    // Turn 2: Second topic (triggers archival of first)
    console.log('  [turn 2] Second topic...');
    const result2 = await runClaude({
      prompt: 'Completely new topic: create a file called poem.txt with a short haiku about coding. Unrelated to a.js.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
      continueSession: true,
    });
    assert(result2.exitCode === 0, 'Turn 2: CLI exited with code 0');

    // Turn 3: Third topic (triggers archival of second)
    console.log('  [turn 3] Third topic...');
    const result3 = await runClaude({
      prompt: 'Another new topic: create a file called config.json with { "debug": true }. Unrelated to previous tasks.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
      continueSession: true,
    });
    assert(result3.exitCode === 0, 'Turn 3: CLI exited with code 0');

    // Should have at least 2 archived topic files (first and second)
    const topics = findTopicFiles(ws.memoryHome, ws.projectDir);
    console.log(`  [info] Topic files: ${topics.length}`);
    for (const t of topics) {
      console.log(`    ${t.name}`);
    }

    assert(topics.length >= 2,
      `At least 2 topic files from 3 topics (got ${topics.length})`);

    // Check sequential numbering
    if (topics.length >= 2) {
      const sorted = topics.map(t => t.name).sort();
      assert(sorted[0].startsWith('01-'), `First file starts with 01- (got ${sorted[0]})`);
      assert(sorted[1].startsWith('02-'), `Second file starts with 02- (got ${sorted[1]})`);
    }
  } finally {
    ws.cleanup();
  }
});

// ─── Run ─────────────────────────────────────────────────────────────────────

runTests();
