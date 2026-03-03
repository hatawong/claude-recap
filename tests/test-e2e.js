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
    dumpMessages = null,    // path to dump full message flow JSON, e.g. '/tmp/case1-messages.json'
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

      if (dumpMessages) {
        fs.writeFileSync(dumpMessages, JSON.stringify(messages, null, 2));
        console.log(`  [info] Messages dumped to ${dumpMessages}`);
      }

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
      dumpMessages: '/tmp/memory-e2e-case1.json',
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
      dumpMessages: '/tmp/memory-e2e-case2-turn1.json',
    });
    assert(result1.exitCode === 0, 'Turn 1: CLI exited with code 0');

    // Stop hook should have registered first topic (via last_assistant_message or transcript fallback)
    const topic1 = getCurrentTopic(ws.memoryHome, ws.projectDir);
    assert(topic1 !== null, `.current_topic registered after Turn 1 (value: ${topic1})`);

    // Turn 2: completely different topic → stop hook detects change → exit 2 → LLM runs set-topic.sh
    console.log('  [turn 2] Different topic...');
    const result2 = await runClaude({
      prompt: 'New topic: create a file called poem.txt with a short haiku about coding. This is unrelated to the previous task.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
      continueSession: true,
      dumpMessages: '/tmp/memory-e2e-case2-turn2.json',
    });
    assert(result2.exitCode === 0, 'Turn 2: CLI exited with code 0');

    // .current_topic should have changed to the new topic
    const topic2 = getCurrentTopic(ws.memoryHome, ws.projectDir);
    assert(topic2 !== null && topic2 !== topic1,
      `.current_topic changed (was: ${topic1}, now: ${topic2})`);

    // The topic switch should have archived the first topic as a summary file
    const topics = findTopicFiles(ws.memoryHome, ws.projectDir);
    assert(topics.length >= 1, `At least 1 topic file created (got ${topics.length})`);

    if (topics.length > 0) {
      const content = topics[0].content;

      // v4 format: set-topic.sh writes "# Topic: slug" header
      assert(content.includes('# Topic:'),
        'Has "# Topic:" header (v4 set-topic.sh format)');

      // v4 format: time range line "> START — END"
      assert(/^> .+ — .+$/m.test(content),
        'Has time range line ("> START — END")');

      // Summary body uses template sections (## Status from topic-tmpl.md)
      assert(content.includes('## Status'),
        'Has "## Status" section (from topic-tmpl.md)');

      // Section has actual content (not just header)
      const sectionMatch = content.match(/## Status[^\n]*\n+([\s\S]*?)(?=\n## |$)/);
      assert(sectionMatch && sectionMatch[1].trim().length > 10,
        'Status section has meaningful content (>10 chars)');
    }
  } finally {
    ws.cleanup();
  }
});

// ---- Case 3: Cross-session memory (Write→Read loop) ----
// Tests the READ side: SessionStart injects topic history → new session can use old memory.
// Case 2 tests WRITE (archival). Case 3 tests READ (injection → awareness).

test('Case 3: Cross-session memory (Write-Read loop)', async () => {
  const ws = createWorkspace();
  try {
    // --- Session 1: produce topic artifacts via topic switch ---

    fs.writeFileSync(path.join(ws.projectDir, 'counter.js'), `class Counter {
  constructor() { this.count = 0; }
  increment() { this.count++; }
  getCount() { return this.count; }
}
module.exports = Counter;
`);

    // Turn 1: coding task → registers first topic
    console.log('  [session 1, turn 1] Coding task...');
    const s1t1 = await runClaude({
      prompt: 'Read counter.js and add a decrement() method to the Counter class. Write the file.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
      dumpMessages: '/tmp/memory-e2e-case3-s1t1.json',
    });
    assert(s1t1.exitCode === 0, 'Session 1 Turn 1: exit code 0');

    // Turn 2: different topic → stop hook detects change → archives Turn 1
    console.log('  [session 1, turn 2] Different topic (triggers archival)...');
    const s1t2 = await runClaude({
      prompt: 'New topic: create a file called notes.txt with "hello world". This is unrelated to counter.js.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
      continueSession: true,
      dumpMessages: '/tmp/memory-e2e-case3-s1t2.json',
    });
    assert(s1t2.exitCode === 0, 'Session 1 Turn 2: exit code 0');

    // Verify Session 1 produced topic artifacts (prerequisite for read test)
    const topicsAfterS1 = findTopicFiles(ws.memoryHome, ws.projectDir);
    assert(topicsAfterS1.length >= 1,
      `Session 1 archived ≥1 topic file (got ${topicsAfterS1.length})`);

    // --- Session 2: NEW session — SessionStart should inject topic history ---

    console.log('  [session 2] New session, checking memory injection...');
    const s2 = await runClaude({
      prompt: 'What was done in previous sessions on this project? Check the topic history that was injected at session start. Be specific about what work was done.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
      // NOT continueSession — proves cross-session injection
      dumpMessages: '/tmp/memory-e2e-case3-s2.json',
    });
    assert(s2.exitCode === 0, 'Session 2: exit code 0');

    // Session 2 should be a separate session (different session dir)
    const sessionsAfterS2 = findSessionDirs(ws.memoryHome, ws.projectDir);
    assert(sessionsAfterS2.length >= 2,
      `≥2 session dirs — proves separate sessions (got ${sessionsAfterS2.length})`);

    // Session 2's LLM should reference Session 1's work
    // (via SessionStart topic history injection → LLM reads topic file → mentions content)
    const s2Text = s2.stdout.toLowerCase();
    const referencedPrevWork =
      s2Text.includes('counter') ||
      s2Text.includes('decrement') ||
      hasToolCall(s2, '.md') ||
      hasToolCall(s2, 'Read');
    assert(referencedPrevWork,
      'Session 2 referenced previous work (counter/decrement or read topic file)');

    // Topic files from Session 1 persist (not cleaned up by Session 2)
    const topicsAfterS2 = findTopicFiles(ws.memoryHome, ws.projectDir);
    assert(topicsAfterS2.length >= topicsAfterS1.length,
      `Topic files persist across sessions (was ${topicsAfterS1.length}, now ${topicsAfterS2.length})`);

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
      dumpMessages: '/tmp/memory-e2e-case4.json',
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
// Tests that topic summary follows the template rule: English section headings, content in user's language.
// Same topic-switch structure as Case 2, but with Chinese prompts.

test('Case 5: Topic content language matches user conversation language', async () => {
  const ws = createWorkspace();
  try {
    // Turn 1: Chinese coding task → registers first topic
    fs.writeFileSync(path.join(ws.projectDir, 'hello.js'), 'console.log("hello");\n');

    console.log('  [turn 1] Chinese coding task...');
    const result1 = await runClaude({
      prompt: '把 hello.js 里的 "hello" 改成 "你好世界"。简短回答。',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
      dumpMessages: '/tmp/memory-e2e-case5-turn1.json',
    });
    assert(result1.exitCode === 0, 'Turn 1: exit code 0');

    const topic1 = getCurrentTopic(ws.memoryHome, ws.projectDir);
    assert(topic1 !== null, `.current_topic registered after Turn 1 (value: ${topic1})`);

    // Turn 2: Different Chinese task → stop hook detects change → archives Turn 1
    console.log('  [turn 2] Different Chinese task (triggers archival)...');
    const result2 = await runClaude({
      prompt: '新任务：创建一个 math.js 文件，导出一个 add(a,b) 函数。这和之前的任务无关。',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
      continueSession: true,
      dumpMessages: '/tmp/memory-e2e-case5-turn2.json',
    });
    assert(result2.exitCode === 0, 'Turn 2: exit code 0');

    const topic2 = getCurrentTopic(ws.memoryHome, ws.projectDir);
    assert(topic2 !== null && topic2 !== topic1,
      `.current_topic changed (was: ${topic1}, now: ${topic2})`);

    const topics = findTopicFiles(ws.memoryHome, ws.projectDir);
    assert(topics.length >= 1, `≥1 topic file created (got ${topics.length})`);

    if (topics.length > 0) {
      const content = topics[0].content;

      // v4 format: set-topic.sh writes "# Topic: slug" header
      assert(content.includes('# Topic:'),
        'Has "# Topic:" header (v4 set-topic.sh format)');

      // v4 format: time range line "> START — END"
      assert(/^> .+ — .+$/m.test(content),
        'Has time range line ("> START — END")');

      // Section heading must be in English (from topic-tmpl.md)
      assert(content.includes('## Status'),
        'Section heading "## Status" is in English');

      // Section content should contain Chinese characters (matching user language)
      const sectionMatch = content.match(/## Status[^\n]*\n+([\s\S]*?)(?=\n## |$)/);
      const hasChinese = sectionMatch && /[\u4e00-\u9fff]/.test(sectionMatch[1]);
      assert(hasChinese,
        'Status section content is in Chinese (matching user language)');
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
      dumpMessages: '/tmp/memory-e2e-case6-s1.json',
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
      dumpMessages: '/tmp/memory-e2e-case6-s2.json',
    });

    assert(result2.exitCode === 0, 'Session 2: CLI exited with code 0');

    // Session 2 should mention bun (injected from REMEMBER.md)
    const mentionsBun = result2.stdout.toLowerCase().includes('bun');
    assert(mentionsBun, 'Session 2: mentions "bun" from injected REMEMBER.md');

  } finally {
    ws.cleanup();
  }
});

// ---- Case 7: archive-pending scan logic (--dry-run) ----
// Tests archive-pending.sh's scan logic directly (not via SessionStart background).
// Why: claude -p doesn't persist JSONL at $HOME/.claude/projects/, so archive-pending
// can't find transcripts in E2E. Instead we construct the expected directory layout
// with a synthetic JSONL and verify --dry-run detects pending topics.

test('Case 7: archive-pending --dry-run detects unarchived topics', async () => {
  const ws = createWorkspace();
  try {
    // --- Step 1: Use Session 1 to establish real .current_topic and capture session_id ---
    console.log('  [session 1] Establish topic via stop hook...');
    const result1 = await runClaude({
      prompt: 'Create a file called utils.js with a function capitalize(str) that capitalizes the first letter. Write the file.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
      dumpMessages: '/tmp/memory-e2e-case7-s1.json',
    });
    assert(result1.exitCode === 0, 'Session 1: exit code 0');

    const topic1 = getCurrentTopic(ws.memoryHome, ws.projectDir);
    assert(topic1 !== null, `.current_topic registered (value: ${topic1})`);

    // Extract session_id from stream-json result message
    const resultMsg = result1.messages.find(m => m.type === 'result');
    const sessionId = resultMsg?.session_id;
    assert(sessionId != null, `session_id captured from stream-json (${sessionId})`);

    // No topic files yet (single topic, no switch)
    const topicsBefore = findTopicFiles(ws.memoryHome, ws.projectDir);
    assert(topicsBefore.length === 0,
      `0 topic files (no topic switch) — this is what archive-pending should find`);

    // --- Step 2: Create synthetic JSONL at expected path for archive-pending ---
    const projectMemDir = getProjectMemoryDir(ws.memoryHome, ws.projectDir);
    const projectId = path.basename(projectMemDir);
    const claudeProjectDir = path.join(os.homedir(), '.claude', 'projects', projectId);
    fs.mkdirSync(claudeProjectDir, { recursive: true });

    // Minimal JSONL: assistant message with topic tag (enough for extract-topic.js)
    const syntheticJsonl = [
      JSON.stringify({
        type: 'assistant', parentMessageId: '1',
        message: { content: [{ type: 'text', text: `› \`${topic1}\`\n\nCreated utils.js with capitalize function.` }] },
        timestamp: new Date().toISOString(),
      }),
    ].join('\n') + '\n';

    const jsonlPath = path.join(claudeProjectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(jsonlPath, syntheticJsonl);
    console.log(`  [info] Created synthetic JSONL at ${jsonlPath}`);

    // --- Step 3: Run archive-pending --dry-run ---
    const { execSync } = require('child_process');
    const dryRunOutput = execSync(
      `bash "${PLUGIN_DIR}/scripts/archive-pending.sh" "${projectMemDir}" "fake-current-session" "${PLUGIN_DIR}" --dry-run`,
      { env: { ...process.env, HOME: os.homedir() }, encoding: 'utf-8', timeout: 30_000 }
    ).trim();

    console.log(`  [info] dry-run output: ${dryRunOutput}`);

    // archive-pending should detect the pending topic
    assert(dryRunOutput.includes('PENDING:'),
      `--dry-run found pending topic (output: ${dryRunOutput.slice(0, 200)})`);
    assert(dryRunOutput.includes(`topic=${topic1}`),
      `Pending topic matches .current_topic slug (${topic1})`);

    // Cleanup synthetic JSONL
    fs.unlinkSync(jsonlPath);
    try { fs.rmdirSync(claudeProjectDir); } catch {}

  } finally {
    ws.cleanup();
  }
});

// ---- Case 8: Compact cold-read recovery ----
// Tests that after compact (.compacted marker), set-topic.sh uses cold-read path
// (extract-topic.js + cold-summarize.sh via claude -p) instead of LLM summary.
// Simulates compact by manually placing .compacted marker between turns.
// Real compact can be triggered by /compact, but that's not available in -p mode.

test('Case 8: Compact cold-read recovery produces accurate summary', async () => {
  const ws = createWorkspace();
  try {
    // Turn 1: coding task → registers topic
    console.log('  [turn 1] Coding task...');
    fs.writeFileSync(path.join(ws.projectDir, 'calc.js'), `
function add(a, b) { return a + b; }
function subtract(a, b) { return a - b; }
module.exports = { add, subtract };
`);

    const result1 = await runClaude({
      prompt: 'Add a multiply(a, b) function to calc.js. Write the file.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
      dumpMessages: '/tmp/memory-e2e-case8-turn1.json',
    });
    assert(result1.exitCode === 0, 'Turn 1: exit code 0');

    const topic1 = getCurrentTopic(ws.memoryHome, ws.projectDir);
    assert(topic1 !== null, `.current_topic registered (value: ${topic1})`);

    // Simulate compact: place .compacted marker (normally created by session-start.sh on source=compact)
    const sessions = findSessionDirs(ws.memoryHome, ws.projectDir);
    assert(sessions.length >= 1, 'Session dir exists');

    const sessionDir = sessions[0].dirPath;
    const compactedFile = path.join(sessionDir, '.compacted');
    fs.writeFileSync(compactedFile, '');
    assert(fs.existsSync(compactedFile), '.compacted marker placed');
    console.log(`  [info] Placed .compacted in ${sessions[0].sessionId}`);

    // Turn 2: different topic → stop hook detects change → set-topic.sh sees .compacted → cold-read path
    console.log('  [turn 2] Topic switch with .compacted (triggers cold-read)...');
    const result2 = await runClaude({
      prompt: 'New topic: create a file called hello.txt with the text "hello world". This is completely unrelated to calc.js.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
      continueSession: true,
      timeout: 180_000, // cold-read via claude -p needs extra time
      dumpMessages: '/tmp/memory-e2e-case8-turn2.json',
    });
    assert(result2.exitCode === 0, 'Turn 2: exit code 0');

    const topic2 = getCurrentTopic(ws.memoryHome, ws.projectDir);
    assert(topic2 !== null && topic2 !== topic1,
      `.current_topic changed (was: ${topic1}, now: ${topic2})`);

    // Topic file should be created (via cold-read or LLM fallback)
    const topics = findTopicFiles(ws.memoryHome, ws.projectDir);
    assert(topics.length >= 1, `≥1 topic file created (got ${topics.length})`);

    if (topics.length > 0) {
      const content = topics[0].content;

      // v4 format
      assert(content.includes('# Topic:'),
        'Has "# Topic:" header (v4 format)');

      assert(/^> .+ — .+$/m.test(content),
        'Has time range line ("> START — END")');

      assert(content.includes('## Status'),
        'Has "## Status" section');

      // Cold-read summary should mention actual work (not hallucinated from truncated context)
      const mentionsWork = content.toLowerCase().includes('calc') ||
        content.toLowerCase().includes('multiply') ||
        content.toLowerCase().includes('function');
      assert(mentionsWork,
        'Summary mentions actual work (calc/multiply/function)');
    }

    // .compacted should be removed after cold-read (set-topic.sh cleans up)
    assert(!fs.existsSync(compactedFile),
      '.compacted marker removed after cold-read');

  } finally {
    ws.cleanup();
  }
});

// ---- Case 9: /save-topic manual checkpoint ----
// Tests /save-topic skill: creates topic file without requiring a topic switch.
// LLM calls save-topic.sh directly (not via stop hook).

test('Case 9: /save-topic creates topic file without topic switch', async () => {
  const ws = createWorkspace();
  try {
    console.log('  [session] Coding task + /save-topic...');
    fs.writeFileSync(path.join(ws.projectDir, 'app.js'), 'console.log("app");\n');

    const result = await runClaude({
      prompt: 'Read app.js and add a comment explaining what it does. Then use /save-topic to checkpoint your progress on this topic.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
      dumpMessages: '/tmp/memory-e2e-case9.json',
    });
    assert(result.exitCode === 0, 'Exit code 0');

    const topic = getCurrentTopic(ws.memoryHome, ws.projectDir);
    assert(topic !== null, `.current_topic registered (value: ${topic})`);

    // /save-topic creates a topic file without needing a topic switch
    const topics = findTopicFiles(ws.memoryHome, ws.projectDir);
    assert(topics.length >= 1, `/save-topic created topic file (got ${topics.length})`);

    if (topics.length > 0) {
      const content = topics[0].content;

      assert(content.includes('# Topic:'),
        'Has "# Topic:" header (v4 format)');

      assert(/^> .+ — .+$/m.test(content),
        'Has time range line ("> START — END")');

      assert(content.includes('## Status'),
        'Has "## Status" section');
    }
  } finally {
    ws.cleanup();
  }
});

// ---- Case 10: Multi-topic single session ----
// Tests 3 topic switches in one session → 2 archived topic files with sequential numbering.
// Verifies the full v4 pipeline works repeatedly within one session.

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
      dumpMessages: '/tmp/memory-e2e-case10-turn1.json',
    });
    assert(result1.exitCode === 0, 'Turn 1: exit code 0');

    const topic1 = getCurrentTopic(ws.memoryHome, ws.projectDir);
    assert(topic1 !== null, `.current_topic registered after Turn 1 (value: ${topic1})`);

    // Turn 2: Second topic (triggers archival of first)
    console.log('  [turn 2] Second topic...');
    const result2 = await runClaude({
      prompt: 'Completely new topic: create a file called poem.txt with a short haiku about coding. Unrelated to a.js.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
      continueSession: true,
      dumpMessages: '/tmp/memory-e2e-case10-turn2.json',
    });
    assert(result2.exitCode === 0, 'Turn 2: exit code 0');

    const topic2 = getCurrentTopic(ws.memoryHome, ws.projectDir);
    assert(topic2 !== null && topic2 !== topic1,
      `.current_topic changed after Turn 2 (was: ${topic1}, now: ${topic2})`);

    // Turn 3: Third topic (triggers archival of second)
    console.log('  [turn 3] Third topic...');
    const result3 = await runClaude({
      prompt: 'Another new topic: create a file called config.json with { "debug": true }. Unrelated to previous tasks.',
      cwd: ws.projectDir,
      memoryHome: ws.memoryHome,
      continueSession: true,
      dumpMessages: '/tmp/memory-e2e-case10-turn3.json',
    });
    assert(result3.exitCode === 0, 'Turn 3: exit code 0');

    const topic3 = getCurrentTopic(ws.memoryHome, ws.projectDir);
    assert(topic3 !== null && topic3 !== topic2,
      `.current_topic changed after Turn 3 (was: ${topic2}, now: ${topic3})`);

    // Should have at least 2 archived topic files (first and second; third is still current)
    const topics = findTopicFiles(ws.memoryHome, ws.projectDir);
    console.log(`  [info] Topic files: ${topics.length}`);
    for (const t of topics) {
      console.log(`    ${t.name}`);
    }

    assert(topics.length >= 2,
      `≥2 topic files from 3 topics (got ${topics.length})`);

    // Sequential numbering
    if (topics.length >= 2) {
      const sorted = topics.map(t => t.name).sort();
      assert(sorted[0].startsWith('01-'), `First file starts with 01- (got ${sorted[0]})`);
      assert(sorted[1].startsWith('02-'), `Second file starts with 02- (got ${sorted[1]})`);
    }

    // Both files should have v4 format
    if (topics.length >= 1) {
      const content = topics[0].content;
      assert(content.includes('# Topic:'), 'First topic file has "# Topic:" header');
      assert(/^> .+ — .+$/m.test(content), 'First topic file has time range');
    }
  } finally {
    ws.cleanup();
  }
});

// ─── Run ─────────────────────────────────────────────────────────────────────

runTests();
