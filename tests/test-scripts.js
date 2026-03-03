/**
 * Script-level tests for v3 features.
 * Tests extract-topic.js, archive-pending.sh, and remember.sh
 * with fixture data. No Claude CLI calls — fast and deterministic.
 *
 * Usage:
 *   node tests/test-scripts.js
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PLUGIN_DIR = path.resolve(__dirname, '..');

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

function createTempDir() {
  const id = crypto.randomBytes(4).toString('hex');
  const dir = path.join(os.tmpdir(), `memory-test-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Fixture: JSONL with multiple topics ──────────────────────────────────────

function createFixtureJSONLWithSlug(filepath, slug) {
  const entries = [
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: `› \`${slug}\`\n\nContent for ${slug}.` }
    ]}, timestamp: '2026-03-02T10:00:01' },
  ];
  fs.writeFileSync(filepath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

function createFixtureJSONL(filepath) {
  const entries = [
    // System message (should be skipped)
    { type: 'system', message: { content: 'system prompt' }, timestamp: '2026-03-02T10:00:00' },
    // User message before any topic tag → untagged
    { type: 'user', message: { role: 'user', content: 'hi' }, timestamp: '2026-03-02T10:00:01' },
    // Assistant with first topic tag
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: '\n› `greeting`\n\nHello! How can I help?' }
    ]}, timestamp: '2026-03-02T10:00:02' },
    // User message in greeting topic
    { type: 'user', message: { role: 'user', content: 'Tell me about JavaScript' }, timestamp: '2026-03-02T10:00:03' },
    // Assistant continues greeting topic
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: '› `greeting`\n\nJavaScript is a versatile programming language.' }
    ]}, timestamp: '2026-03-02T10:00:04' },
    // file-history-snapshot (should be skipped)
    { type: 'file-history-snapshot', timestamp: '2026-03-02T10:00:05' },
    // Topic switch
    { type: 'user', message: { role: 'user', content: '帮我修复 app.js 的 bug' }, timestamp: '2026-03-02T10:00:06' },
    // Assistant with new topic
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: '› `fix-app-bug`\n\n让我看一下 app.js 的代码。' },
      { type: 'tool_use', id: 'tool1', name: 'Read', input: { file_path: 'app.js' } }
    ]}, timestamp: '2026-03-02T10:00:07' },
    // User (tool_result — should be included as user message)
    { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tool1', content: 'file content here' }
    ]}, timestamp: '2026-03-02T10:00:08' },
    // Assistant continues fix-app-bug
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: '› `fix-app-bug`\n\n找到了问题，已修复。' }
    ]}, timestamp: '2026-03-02T10:00:09' },
  ];

  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(filepath, lines);
}

// ─── Test: extract-topic.js ──────────────────────────────────────────────────

console.log('Test: extract-topic.js');

(function testExtractTopicListAll() {
  const tmpDir = createTempDir();
  const jsonlPath = path.join(tmpDir, 'test.jsonl');
  createFixtureJSONL(jsonlPath);

  const result = spawnSync('node', [
    path.join(PLUGIN_DIR, 'scripts/extract-topic.js'),
    jsonlPath,
    '__all__'
  ], { encoding: 'utf-8' });

  const topics = result.stdout.trim().split('\n');
  assert(topics.includes('__untagged__'), '__all__: includes __untagged__');
  assert(topics.includes('greeting'), '__all__: includes greeting');
  assert(topics.includes('fix-app-bug'), '__all__: includes fix-app-bug');
  assert(topics.length === 3, `__all__: exactly 3 topics (got ${topics.length})`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testExtractSpecificTopic() {
  const tmpDir = createTempDir();
  const jsonlPath = path.join(tmpDir, 'test.jsonl');
  createFixtureJSONL(jsonlPath);

  const result = spawnSync('node', [
    path.join(PLUGIN_DIR, 'scripts/extract-topic.js'),
    jsonlPath,
    'greeting'
  ], { encoding: 'utf-8' });

  const output = result.stdout;
  assert(output.includes('<!-- topic_start:'), 'greeting: has topic_start timestamp');
  assert(output.includes('<!-- topic_end:'), 'greeting: has topic_end timestamp');
  assert(output.includes('【A】'), 'greeting: has 【A】 heading');
  assert(output.includes('Hello! How can I help?'), 'greeting: contains assistant text');
  assert(output.includes('【U】'), 'greeting: has 【U】 heading');
  assert(output.includes('Tell me about JavaScript'), 'greeting: contains user message');
  assert(!output.includes('› `greeting`'), 'greeting: topic tag is stripped');
  assert(!output.includes('fix-app-bug'), 'greeting: does not contain other topic content');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testExtractLastTopic() {
  const tmpDir = createTempDir();
  const jsonlPath = path.join(tmpDir, 'test.jsonl');
  createFixtureJSONL(jsonlPath);

  const result = spawnSync('node', [
    path.join(PLUGIN_DIR, 'scripts/extract-topic.js'),
    jsonlPath,
    // no slug → defaults to last topic
  ], { encoding: 'utf-8' });

  const output = result.stdout;
  assert(output.includes('让我看一下'), 'last topic: contains fix-app-bug content');
  assert(output.includes('找到了问题'), 'last topic: contains fix conclusion');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testExtractNonexistentTopic() {
  const tmpDir = createTempDir();
  const jsonlPath = path.join(tmpDir, 'test.jsonl');
  createFixtureJSONL(jsonlPath);

  const result = spawnSync('node', [
    path.join(PLUGIN_DIR, 'scripts/extract-topic.js'),
    jsonlPath,
    'nonexistent'
  ], { encoding: 'utf-8' });

  assert(result.status === 2, 'nonexistent topic: exit code 2');
  assert(result.stderr.includes('No messages found'), 'nonexistent topic: stderr message');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testExtractStripsToolUse() {
  const tmpDir = createTempDir();
  const jsonlPath = path.join(tmpDir, 'test.jsonl');
  createFixtureJSONL(jsonlPath);

  const result = spawnSync('node', [
    path.join(PLUGIN_DIR, 'scripts/extract-topic.js'),
    jsonlPath,
    'fix-app-bug'
  ], { encoding: 'utf-8' });

  const output = result.stdout;
  assert(!output.includes('tool_use'), 'fix-app-bug: tool_use blocks are stripped');
  assert(!output.includes('Read'), 'fix-app-bug: tool names not in output');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

console.log('');

// ─── Test: archive-pending.sh (--dry-run) ────────────────────────────────────

console.log('Test: archive-pending.sh');

(function testArchivePendingDryRun() {
  const tmpDir = createTempDir();

  // Simulate project memory structure
  const projectDir = path.join(tmpDir, 'projects', '-test-project');
  const session1 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const session2 = 'ffffffff-1111-2222-3333-444444444444';
  const session1Dir = path.join(projectDir, session1);
  const session2Dir = path.join(projectDir, session2);

  fs.mkdirSync(session1Dir, { recursive: true });
  fs.mkdirSync(session2Dir, { recursive: true });

  // Session 1: unarchived
  fs.writeFileSync(path.join(session1Dir, '.current_topic'), 'greeting');

  // Session 2: already archived
  fs.writeFileSync(path.join(session2Dir, '.current_topic'), 'coding');
  fs.writeFileSync(path.join(session2Dir, '01-coding.md'), '# coding\n\n## Status\nDone.');

  // Create JSONL
  const claudeProjectDir = path.join(tmpDir, '.claude', 'projects', '-test-project');
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  createFixtureJSONL(path.join(claudeProjectDir, `${session1}.jsonl`));

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'scripts/archive-pending.sh'),
    projectDir,
    'current-session-id',
    PLUGIN_DIR,
    '--dry-run',
  ], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: tmpDir },
  });

  assert(result.status === 0, 'archive-pending --dry-run: exits 0');
  assert(result.stdout.includes('PENDING'), 'archive-pending --dry-run: outputs PENDING');
  assert(result.stdout.includes('greeting'), 'archive-pending --dry-run: includes unarchived topic');
  assert(result.stdout.includes(session1), 'archive-pending --dry-run: includes session ID');
  assert(!result.stdout.includes(session2), 'archive-pending --dry-run: skips archived session');

  // Extracted file should exist (extraction still runs in dry-run)
  assert(fs.existsSync(path.join(session1Dir, '.extracted-greeting.md')),
    'archive-pending --dry-run: extraction file created');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testArchivePendingDryRunNothingPending() {
  const tmpDir = createTempDir();
  const projectDir = path.join(tmpDir, 'projects', '-test-project');
  fs.mkdirSync(projectDir, { recursive: true });

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'scripts/archive-pending.sh'),
    projectDir,
    'current-session-id',
    PLUGIN_DIR,
    '--dry-run',
  ], { encoding: 'utf-8' });

  assert(result.status === 0, 'archive-pending --dry-run empty: exits 0');
  assert(!result.stdout.includes('PENDING'), 'archive-pending --dry-run empty: no output');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testArchivePendingDryRunProcessesCompacted() {
  const tmpDir = createTempDir();
  const projectDir = path.join(tmpDir, 'projects', '-test-project');
  const compactedSession = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const compactedDir = path.join(projectDir, compactedSession);

  fs.mkdirSync(compactedDir, { recursive: true });
  fs.writeFileSync(path.join(compactedDir, '.current_topic'), 'greeting');
  fs.writeFileSync(path.join(compactedDir, '.compacted'), '');

  const claudeProjectDir = path.join(tmpDir, '.claude', 'projects', '-test-project');
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  createFixtureJSONL(path.join(claudeProjectDir, `${compactedSession}.jsonl`));

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'scripts/archive-pending.sh'),
    projectDir,
    'current-session-id',
    PLUGIN_DIR,
    '--dry-run',
  ], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: tmpDir },
  });

  assert(result.status === 0, 'archive-pending --dry-run compacted: exits 0');
  assert(result.stdout.includes('PENDING'), 'archive-pending --dry-run compacted: processes compacted session');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

console.log('');

// ─── Test: remember.sh ───────────────────────────────────────────────────────

console.log('Test: remember.sh');

(function testRememberGlobal() {
  const tmpDir = createTempDir();

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'scripts/remember.sh'),
    'global',
    'Use bun instead of npm',
  ], {
    encoding: 'utf-8',
    env: { ...process.env, MEMORY_HOME: tmpDir, CLAUDE_CWD: '/test/project' },
  });

  assert(result.status === 0, 'global: exits with code 0');
  assert(result.stdout.includes('Remembered (global)'), 'global: confirmation message');

  const rememberFile = path.join(tmpDir, 'REMEMBER.md');
  assert(fs.existsSync(rememberFile), 'global: REMEMBER.md created');

  const content = fs.readFileSync(rememberFile, 'utf-8');
  assert(content.includes('# REMEMBER (Global)'), 'global: has header');
  assert(content.includes('- Use bun instead of npm'), 'global: has entry');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testRememberProject() {
  const tmpDir = createTempDir();

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'scripts/remember.sh'),
    'project',
    'Always run tests with --verbose',
  ], {
    encoding: 'utf-8',
    env: { ...process.env, MEMORY_HOME: tmpDir, CLAUDE_CWD: '/test/project' },
  });

  assert(result.status === 0, 'project: exits with code 0');

  const rememberFile = path.join(tmpDir, 'projects', '-test-project', 'REMEMBER.md');
  assert(fs.existsSync(rememberFile), 'project: REMEMBER.md created');

  const content = fs.readFileSync(rememberFile, 'utf-8');
  assert(content.includes('# REMEMBER (Project)'), 'project: has header');
  assert(content.includes('- Always run tests with --verbose'), 'project: has entry');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testRememberAppends() {
  const tmpDir = createTempDir();
  const env = { ...process.env, MEMORY_HOME: tmpDir, CLAUDE_CWD: '/test/project' };

  spawnSync('bash', [path.join(PLUGIN_DIR, 'scripts/remember.sh'), 'global', 'First entry'], { env });
  spawnSync('bash', [path.join(PLUGIN_DIR, 'scripts/remember.sh'), 'global', 'Second entry'], { env });

  const content = fs.readFileSync(path.join(tmpDir, 'REMEMBER.md'), 'utf-8');
  assert(content.includes('- First entry'), 'append: first entry preserved');
  assert(content.includes('- Second entry'), 'append: second entry added');

  const lines = content.split('\n').filter(l => l.startsWith('- '));
  assert(lines.length === 2, `append: exactly 2 entries (got ${lines.length})`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testRememberInvalidScope() {
  const tmpDir = createTempDir();

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'scripts/remember.sh'),
    'invalid',
    'test',
  ], {
    encoding: 'utf-8',
    env: { ...process.env, MEMORY_HOME: tmpDir, CLAUDE_CWD: '/test/project' },
  });

  assert(result.status !== 0, 'invalid scope: non-zero exit code');
  assert(result.stderr.includes('must be'), 'invalid scope: error message');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

console.log('');

// ─── Test: compact improvements ─────────────────────────────────────────────

console.log('Test: compact improvements');

(function testSetTopicOverwritesExisting() {
  const tmpDir = createTempDir();
  const sessionDir = path.join(tmpDir, 'memory', 'projects', '-test-project', 'test-session');
  fs.mkdirSync(sessionDir, { recursive: true });

  // Create an existing topic file
  const existingFile = path.join(sessionDir, '01-my-topic.md');
  fs.writeFileSync(existingFile, '# my-topic\n\n### Summary (2026-03-01)\n\nOld content here.');
  fs.writeFileSync(path.join(sessionDir, '.current_topic'), 'my-topic');

  // Create JSONL so canonical path resolves to 01-my-topic.md
  const claudeProjectDir = path.join(tmpDir, '.claude', 'projects', '-test-project');
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  createFixtureJSONLWithSlug(path.join(claudeProjectDir, 'test-session.jsonl'), 'my-topic');

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'scripts/set-topic.sh'),
    'my-topic',
    'new-topic',
    'test-session',
    '## Status\nNew and improved content.'
  ], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      MEMORY_HOME: path.join(tmpDir, 'memory'),
      CLAUDE_CWD: '/test-project',
      HOME: tmpDir,
    },
  });

  assert(result.status === 0, 'set-topic overwrite: exits with code 0');
  const content = fs.readFileSync(existingFile, 'utf-8');
  assert(!content.includes('Old content'), 'set-topic overwrite: old content is gone');
  assert(content.includes('New and improved content'), 'set-topic overwrite: new content present');
  assert(content.includes('# Topic: my-topic'), 'set-topic overwrite: has Topic heading');
  assert(content.includes('> '), 'set-topic overwrite: has time range blockquote');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testSaveTopicCompactedFallback() {
  // When .compacted exists, save-topic.sh should attempt cold-read,
  // fall back to LLM summary (claude CLI unavailable or extraction fails),
  // and preserve .compacted (unlike set-topic.sh which deletes it)
  const tmpDir = createTempDir();
  const sessionDir = path.join(tmpDir, 'memory', 'projects', '-test-project', 'test-session');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, '.current_topic'), 'greeting');
  fs.writeFileSync(path.join(sessionDir, '.compacted'), '');

  // Create JSONL with 'greeting' topic so extraction succeeds
  const claudeProjectDir = path.join(tmpDir, '.claude', 'projects', '-test-project');
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  createFixtureJSONL(path.join(claudeProjectDir, 'test-session.jsonl'));

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'scripts/save-topic.sh'),
    'greeting',
    'test-session',
    '## Status\nFallback LLM summary.'
  ], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      MEMORY_HOME: path.join(tmpDir, 'memory'),
      CLAUDE_CWD: '/test-project',
      HOME: tmpDir,
    },
  });

  assert(result.status === 0, 'save-topic compacted: exits 0');
  // .compacted must be preserved — save-topic does NOT delete it
  assert(fs.existsSync(path.join(sessionDir, '.compacted')),
    'save-topic compacted: .compacted marker preserved');
  // Archive file should exist
  const archiveFile = path.join(sessionDir, '01-greeting.md');
  assert(fs.existsSync(archiveFile), 'save-topic compacted: archive file created');
  // .extracted file should be cleaned up
  assert(!fs.existsSync(path.join(sessionDir, '.extracted-greeting.md')),
    'save-topic compacted: extracted file cleaned up');
  // stderr should mention cold-reading attempt
  assert(result.stderr.includes('Compacted session detected'),
    'save-topic compacted: attempted cold-read');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testSaveTopicNormalPath() {
  // Without .compacted, save-topic.sh uses LLM summary directly
  const tmpDir = createTempDir();
  const sessionDir = path.join(tmpDir, 'memory', 'projects', '-test-project', 'test-session');
  fs.mkdirSync(sessionDir, { recursive: true });

  // Create JSONL so canonical path resolves correctly
  const claudeProjectDir = path.join(tmpDir, '.claude', 'projects', '-test-project');
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  createFixtureJSONLWithSlug(path.join(claudeProjectDir, 'test-session.jsonl'), 'my-topic');

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'scripts/save-topic.sh'),
    'my-topic',
    'test-session',
    '## Status\nDirect LLM summary.'
  ], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      MEMORY_HOME: path.join(tmpDir, 'memory'),
      CLAUDE_CWD: '/test-project',
      HOME: tmpDir,
    },
  });

  assert(result.status === 0, 'save-topic normal: exits 0');
  const archiveFile = path.join(sessionDir, '01-my-topic.md');
  assert(fs.existsSync(archiveFile), 'save-topic normal: archive file created');
  const content = fs.readFileSync(archiveFile, 'utf-8');
  assert(content.includes('Direct LLM summary'), 'save-topic normal: LLM summary used');
  assert(content.includes('# Topic: my-topic'), 'save-topic normal: has Topic heading');
  // .current_topic should be created
  assert(fs.existsSync(path.join(sessionDir, '.current_topic')),
    'save-topic normal: .current_topic created');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testSetTopicCompactedFallsBackOnColdReadFailure() {
  // When .compacted exists and slug is in JSONL but cold-read summarization fails
  // (claude CLI unavailable), set-topic.sh should fall back to LLM summary and still delete .compacted
  const tmpDir = createTempDir();
  const sessionDir = path.join(tmpDir, 'memory', 'projects', '-test-project', 'test-session');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, '.current_topic'), 'greeting');
  fs.writeFileSync(path.join(sessionDir, '.compacted'), '');

  // Create JSONL with 'greeting' topic
  const claudeProjectDir = path.join(tmpDir, '.claude', 'projects', '-test-project');
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  createFixtureJSONL(path.join(claudeProjectDir, 'test-session.jsonl'));

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'scripts/set-topic.sh'),
    'greeting',
    'new-topic',
    'test-session',
    '## Status\nFallback LLM summary content.'
  ], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      MEMORY_HOME: path.join(tmpDir, 'memory'),
      CLAUDE_CWD: '/test-project',
      HOME: tmpDir,
      // PATH intentionally not modified — claude CLI may or may not be available
    },
  });

  assert(result.status === 0, 'set-topic compacted fallback: exits 0');
  // .compacted should be removed regardless of cold-read success
  assert(!fs.existsSync(path.join(sessionDir, '.compacted')),
    'set-topic compacted fallback: .compacted marker removed');
  // Archive file should exist with fallback content (greeting is 1st topic in JSONL)
  const archiveFile = path.join(sessionDir, '01-greeting.md');
  assert(fs.existsSync(archiveFile), 'set-topic compacted fallback: archive file created');
  // .current_topic should be updated to new topic
  const currentTopic = fs.readFileSync(path.join(sessionDir, '.current_topic'), 'utf-8').trim();
  assert(currentTopic === 'new-topic', 'set-topic compacted fallback: current topic updated');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testArchivePendingProcessesCompactedSession() {
  const tmpDir = createTempDir();
  const projectDir = path.join(tmpDir, 'projects', '-test-project');
  const compactedSession = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const compactedDir = path.join(projectDir, compactedSession);

  fs.mkdirSync(compactedDir, { recursive: true });
  fs.writeFileSync(path.join(compactedDir, '.current_topic'), 'greeting');
  fs.writeFileSync(path.join(compactedDir, '.compacted'), '');

  // Create fake JSONL
  const claudeProjectDir = path.join(tmpDir, '.claude', 'projects', '-test-project');
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  createFixtureJSONL(path.join(claudeProjectDir, `${compactedSession}.jsonl`));

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'scripts/archive-pending.sh'),
    projectDir,
    'current-session-id',
    PLUGIN_DIR,
  ], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: tmpDir },
  });

  // archive-pending no longer skips .compacted sessions — it processes them
  // (claude CLI not available in test, so LLM summarization is skipped, but extraction should happen)
  assert(result.status === 0, 'archive-pending processes compacted: exits 0');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testSessionStartSkipsArchivePendingOnCompact() {
  const tmpDir = createTempDir();

  // Set up a pending session that would normally trigger archive-pending
  const projectDir = path.join(tmpDir, 'memory', 'projects', '-test-project');
  const pendingSession = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const currentSession = 'ffffffff-1111-2222-3333-444444444444';
  const pendingDir = path.join(projectDir, pendingSession);
  const currentDir = path.join(projectDir, currentSession);

  fs.mkdirSync(pendingDir, { recursive: true });
  fs.mkdirSync(currentDir, { recursive: true });
  fs.writeFileSync(path.join(pendingDir, '.current_topic'), 'greeting');
  fs.writeFileSync(path.join(currentDir, '.current_topic'), 'coding');

  const claudeProjectDir = path.join(tmpDir, '.claude', 'projects', '-test-project');
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  createFixtureJSONL(path.join(claudeProjectDir, `${pendingSession}.jsonl`));
  createFixtureJSONL(path.join(claudeProjectDir, `${currentSession}.jsonl`));

  const input = JSON.stringify({
    cwd: '/test-project',
    session_id: currentSession,
    source: 'compact'
  });

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'hooks/session-start.sh'),
  ], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, HOME: tmpDir, MEMORY_HOME: path.join(tmpDir, 'memory') },
  });

  assert(!result.stdout.includes('Pending Topic Archives'),
    'compact: no archive-pending output');
  assert(!fs.existsSync(path.join(pendingDir, '.extracted-greeting.md')),
    'compact: no extraction performed on pending session');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testSessionStartCreatesCompactedAndRecoveryInstructions() {
  const tmpDir = createTempDir();

  const projectDir = path.join(tmpDir, 'memory', 'projects', '-test-project');
  const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const sessionDir = path.join(projectDir, sessionId);

  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, '.current_topic'), 'coding');

  const claudeProjectDir = path.join(tmpDir, '.claude', 'projects', '-test-project');
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  createFixtureJSONL(path.join(claudeProjectDir, `${sessionId}.jsonl`));

  const input = JSON.stringify({
    cwd: '/test-project',
    session_id: sessionId,
    source: 'compact'
  });

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'hooks/session-start.sh'),
  ], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, HOME: tmpDir, MEMORY_HOME: path.join(tmpDir, 'memory') },
  });

  assert(fs.existsSync(path.join(sessionDir, '.compacted')),
    'compact: .compacted marker created');
  // Note: compact recovery calls `claude -p` which is not available in test env,
  // so we only verify the .compacted marker is created. Recovery output is tested via E2E.

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testStopHookPassesThroughCompacted() {
  // stop.sh no longer handles .compacted — set-topic.sh is responsible for
  // detecting it, cold-reading from JSONL, and deleting the marker.
  const tmpDir = createTempDir();
  const memoryHome = path.join(tmpDir, 'memory');
  const sessionDir = path.join(memoryHome, 'projects', '-test-project', 'test-session');

  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, '.current_topic'), 'old-topic');
  fs.writeFileSync(path.join(sessionDir, '.compacted'), '');

  const input = JSON.stringify({
    cwd: '/test-project',
    session_id: 'test-session',
    stop_hook_active: false,
    last_assistant_message: '› `new-topic`\n\nSome response here.'
  });

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'hooks/stop.sh'),
  ], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, MEMORY_HOME: memoryHome },
  });

  assert(result.status === 2, 'stop compacted: exit code 2');
  assert(result.stderr.includes('set-topic.sh'), 'stop compacted: stderr contains set-topic.sh bash command');
  assert(result.stderr.includes('old-topic'), 'stop compacted: includes old topic slug');
  // .compacted is NOT removed by stop.sh — set-topic.sh handles it
  assert(fs.existsSync(path.join(sessionDir, '.compacted')),
    'stop compacted: .compacted marker preserved for set-topic.sh');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testStopHookGivesBashCommandWhenNotCompacted() {
  const tmpDir = createTempDir();
  const memoryHome = path.join(tmpDir, 'memory');
  const sessionDir = path.join(memoryHome, 'projects', '-test-project', 'test-session');

  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, '.current_topic'), 'old-topic');
  // NO .compacted file

  const input = JSON.stringify({
    cwd: '/test-project',
    session_id: 'test-session',
    stop_hook_active: false,
    last_assistant_message: '› `new-topic`\n\nSome response here.'
  });

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'hooks/stop.sh'),
  ], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, MEMORY_HOME: memoryHome },
  });

  assert(result.status === 2, 'stop normal: exit code 2');
  assert(result.stderr.includes('set-topic.sh'), 'stop normal: stderr contains set-topic.sh bash command');
  assert(result.stderr.includes('old-topic'), 'stop normal: includes old topic slug');
  assert(result.stderr.includes('new-topic'), 'stop normal: includes new topic slug');
  assert(result.stderr.includes('## Status'), 'stop normal: includes summary format template');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

console.log('');

// ─── Test: stop.sh edge cases ────────────────────────────────────────────────

console.log('Test: stop.sh edge cases');

(function testStopHookFirstTopicRegistration() {
  // First topic in session: old_topic=none → register, exit 0 (no archival)
  const tmpDir = createTempDir();
  const memoryHome = path.join(tmpDir, 'memory');
  const sessionDir = path.join(memoryHome, 'projects', '-test-project', 'test-session');

  // No .current_topic file → old_topic will be "none"
  fs.mkdirSync(sessionDir, { recursive: true });

  const input = JSON.stringify({
    cwd: '/test-project',
    session_id: 'test-session',
    stop_hook_active: false,
    last_assistant_message: '› `first-topic`\n\nHello!'
  });

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'hooks/stop.sh'),
  ], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, MEMORY_HOME: memoryHome },
  });

  assert(result.status === 0, 'first topic: exit code 0 (no archival)');
  assert(result.stderr.includes('first topic registered'), 'first topic: stderr confirms registration');

  const currentTopic = fs.readFileSync(path.join(sessionDir, '.current_topic'), 'utf-8').trim();
  assert(currentTopic === 'first-topic', 'first topic: .current_topic written');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testStopHookSameTopicPassThrough() {
  // Same topic → exit 0 (pass through)
  const tmpDir = createTempDir();
  const memoryHome = path.join(tmpDir, 'memory');
  const sessionDir = path.join(memoryHome, 'projects', '-test-project', 'test-session');

  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, '.current_topic'), 'same-topic');

  const input = JSON.stringify({
    cwd: '/test-project',
    session_id: 'test-session',
    stop_hook_active: false,
    last_assistant_message: '› `same-topic`\n\nContinuing the same topic.'
  });

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'hooks/stop.sh'),
  ], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, MEMORY_HOME: memoryHome },
  });

  assert(result.status === 0, 'same topic: exit code 0');
  assert(result.stderr.includes('topic unchanged'), 'same topic: stderr confirms no change');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testStopHookNoTagPassThrough() {
  // No topic tag in message → exit 0 (pass through)
  const tmpDir = createTempDir();
  const memoryHome = path.join(tmpDir, 'memory');

  const input = JSON.stringify({
    cwd: '/test-project',
    session_id: 'test-session',
    stop_hook_active: false,
    last_assistant_message: 'Just a regular response without any tag.'
  });

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'hooks/stop.sh'),
  ], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, MEMORY_HOME: memoryHome },
  });

  assert(result.status === 0, 'no tag: exit code 0');
  assert(result.stderr.includes('no topic tag found'), 'no tag: stderr confirms pass through');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testStopHookAntiRecursion() {
  // stop_hook_active=true → exit 0 immediately (anti-recursion)
  const tmpDir = createTempDir();
  const memoryHome = path.join(tmpDir, 'memory');

  const input = JSON.stringify({
    cwd: '/test-project',
    session_id: 'test-session',
    stop_hook_active: true,
    last_assistant_message: '› `new-topic`\n\nThis should be ignored.'
  });

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'hooks/stop.sh'),
  ], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, MEMORY_HOME: memoryHome },
  });

  assert(result.status === 0, 'anti-recursion: exit code 0');
  // Should NOT process the tag at all
  assert(!result.stderr.includes('extracted topic tag'), 'anti-recursion: no tag extraction');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

console.log('');

// ─── Test: session-start.sh injection ────────────────────────────────────────

console.log('Test: session-start.sh injection');

(function testSessionStartInjectsGlobalRemember() {
  const tmpDir = createTempDir();
  const memoryHome = path.join(tmpDir, 'memory');

  // Create global REMEMBER.md
  fs.mkdirSync(memoryHome, { recursive: true });
  fs.writeFileSync(path.join(memoryHome, 'REMEMBER.md'), '# REMEMBER (Global)\n\n- Always use bun\n');

  const input = JSON.stringify({
    cwd: '/test-project',
    session_id: 'test-session-001',
    source: 'startup'
  });

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'hooks/session-start.sh'),
  ], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, HOME: tmpDir, MEMORY_HOME: memoryHome },
  });

  assert(result.status === 0, 'startup: exits 0');
  assert(result.stdout.includes('Things You Should Remember (Global)'), 'startup: global REMEMBER header');
  assert(result.stdout.includes('Always use bun'), 'startup: global REMEMBER content');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testSessionStartInjectsProjectRemember() {
  const tmpDir = createTempDir();
  const memoryHome = path.join(tmpDir, 'memory');
  const projectDir = path.join(memoryHome, 'projects', '-test-project');

  // Create project REMEMBER.md
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'REMEMBER.md'), '# REMEMBER (Project)\n\n- Never use bun here\n');

  const input = JSON.stringify({
    cwd: '/test-project',
    session_id: 'test-session-002',
    source: 'startup'
  });

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'hooks/session-start.sh'),
  ], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, HOME: tmpDir, MEMORY_HOME: memoryHome },
  });

  assert(result.status === 0, 'project remember: exits 0');
  assert(result.stdout.includes('Things You Should Remember (This Project)'), 'project remember: header');
  assert(result.stdout.includes('Never use bun here'), 'project remember: content');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testSessionStartInjectsTopicTagRule() {
  const tmpDir = createTempDir();
  const memoryHome = path.join(tmpDir, 'memory');

  const input = JSON.stringify({
    cwd: '/test-project',
    session_id: 'test-session-003',
    source: 'startup'
  });

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'hooks/session-start.sh'),
  ], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, HOME: tmpDir, MEMORY_HOME: memoryHome },
  });

  assert(result.stdout.includes('Topic Tag Rule'), 'tag rule: header present');
  assert(result.stdout.includes('your-topic-slug'), 'tag rule: slug format example');
  assert(result.stdout.includes('Current topic:'), 'tag rule: current topic shown');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testSessionStartInjectsTopicHistory() {
  const tmpDir = createTempDir();
  const memoryHome = path.join(tmpDir, 'memory');
  const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const sessionDir = path.join(memoryHome, 'projects', '-test-project', sessionId);

  // Create a topic file from a previous session
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, '01-old-topic.md'), '# Topic: old-topic\n\n> 2026-03-04 10:00 — 2026-03-04 11:00\n\n## Status\nDone.');

  const input = JSON.stringify({
    cwd: '/test-project',
    session_id: 'new-session-id',
    source: 'startup'
  });

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'hooks/session-start.sh'),
  ], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, HOME: tmpDir, MEMORY_HOME: memoryHome },
  });

  assert(result.stdout.includes('Topic History'), 'topic history: header present');
  assert(result.stdout.includes('01-old-topic'), 'topic history: topic file listed');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testSessionStartNoRememberGraceful() {
  // No REMEMBER.md files → should not crash, should still inject Tag Rule
  const tmpDir = createTempDir();
  const memoryHome = path.join(tmpDir, 'memory');

  const input = JSON.stringify({
    cwd: '/test-project',
    session_id: 'test-session-004',
    source: 'startup'
  });

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'hooks/session-start.sh'),
  ], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, HOME: tmpDir, MEMORY_HOME: memoryHome },
  });

  assert(result.status === 0, 'no remember: exits 0');
  assert(!result.stdout.includes('Things You Should Remember'), 'no remember: no REMEMBER section');
  assert(result.stdout.includes('Topic Tag Rule'), 'no remember: Tag Rule still injected');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testSessionStartResumeSource() {
  const tmpDir = createTempDir();
  const memoryHome = path.join(tmpDir, 'memory');

  const input = JSON.stringify({
    cwd: '/test-project',
    session_id: 'test-session-005',
    source: 'resume'
  });

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'hooks/session-start.sh'),
  ], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, HOME: tmpDir, MEMORY_HOME: memoryHome },
  });

  assert(result.status === 0, 'resume: exits 0');
  assert(result.stdout.includes('source=resume'), 'resume: source logged');
  assert(result.stdout.includes('Topic Tag Rule'), 'resume: Tag Rule injected');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

console.log('');

// ─── Test: set-topic.sh edge cases ───────────────────────────────────────────

console.log('Test: set-topic.sh edge cases');

(function testSetTopicInvalidSlug() {
  const tmpDir = createTempDir();

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'scripts/set-topic.sh'),
    'INVALID_SLUG',
    'new-topic',
    'test-session',
    'summary'
  ], {
    encoding: 'utf-8',
    env: { ...process.env, MEMORY_HOME: path.join(tmpDir, 'memory'), CLAUDE_CWD: '/test-project', HOME: tmpDir },
  });

  assert(result.status !== 0, 'invalid slug: non-zero exit');
  assert(result.stderr.includes('invalid topic slug'), 'invalid slug: error message');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testSetTopicOldNoneSkipsArchival() {
  // old_slug=none, summary=none → skip archival, just update .current_topic
  const tmpDir = createTempDir();
  const sessionDir = path.join(tmpDir, 'memory', 'projects', '-test-project', 'test-session');

  // Create JSONL so set-topic.sh doesn't error on sequence lookup
  const claudeProjectDir = path.join(tmpDir, '.claude', 'projects', '-test-project');
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  createFixtureJSONLWithSlug(path.join(claudeProjectDir, 'test-session.jsonl'), 'first-topic');

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'scripts/set-topic.sh'),
    'none',
    'first-topic',
    'test-session',
    'none'
  ], {
    encoding: 'utf-8',
    env: { ...process.env, MEMORY_HOME: path.join(tmpDir, 'memory'), CLAUDE_CWD: '/test-project', HOME: tmpDir },
  });

  assert(result.status === 0, 'old=none: exits 0');
  // No archive file should be created
  fs.mkdirSync(sessionDir, { recursive: true });
  const mdFiles = fs.readdirSync(sessionDir).filter(f => f.endsWith('.md') && !f.startsWith('.'));
  assert(mdFiles.length === 0, 'old=none: no archive file created');
  // .current_topic should be set
  const currentTopic = fs.readFileSync(path.join(sessionDir, '.current_topic'), 'utf-8').trim();
  assert(currentTopic === 'first-topic', 'old=none: .current_topic set to first-topic');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testSetTopicSequenceNumber() {
  // With multiple topics in JSONL, sequence numbers should be correct
  const tmpDir = createTempDir();
  const sessionDir = path.join(tmpDir, 'memory', 'projects', '-test-project', 'test-session');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, '.current_topic'), 'greeting');

  // Create JSONL with greeting → fix-app-bug (fixture has both)
  const claudeProjectDir = path.join(tmpDir, '.claude', 'projects', '-test-project');
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  createFixtureJSONL(path.join(claudeProjectDir, 'test-session.jsonl'));

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'scripts/set-topic.sh'),
    'greeting',
    'fix-app-bug',
    'test-session',
    '## Status\nGreeting done.'
  ], {
    encoding: 'utf-8',
    env: { ...process.env, MEMORY_HOME: path.join(tmpDir, 'memory'), CLAUDE_CWD: '/test-project', HOME: tmpDir },
  });

  assert(result.status === 0, 'sequence: exits 0');
  // greeting is the 1st non-untagged topic → 01-greeting.md
  assert(fs.existsSync(path.join(sessionDir, '01-greeting.md')), 'sequence: 01-greeting.md created');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

console.log('');

// ─── Test: save-topic.sh edge cases ──────────────────────────────────────────

console.log('Test: save-topic.sh edge cases');

(function testSaveTopicColdFlag() {
  // --cold flag forces cold-read from JSONL (even without .compacted)
  const tmpDir = createTempDir();
  const sessionDir = path.join(tmpDir, 'memory', 'projects', '-test-project', 'test-session');
  fs.mkdirSync(sessionDir, { recursive: true });
  // NO .compacted file — --cold should still force cold-read

  const claudeProjectDir = path.join(tmpDir, '.claude', 'projects', '-test-project');
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  createFixtureJSONL(path.join(claudeProjectDir, 'test-session.jsonl'));

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'scripts/save-topic.sh'),
    '--cold',
    'greeting',
    'test-session',
    '## Status\nFallback summary.'
  ], {
    encoding: 'utf-8',
    env: { ...process.env, MEMORY_HOME: path.join(tmpDir, 'memory'), CLAUDE_CWD: '/test-project', HOME: tmpDir },
  });

  assert(result.status === 0, '--cold: exits 0');
  assert(result.stderr.includes('Cold-read forced'), '--cold: stderr confirms cold-read forced');
  // Archive file should exist
  assert(fs.existsSync(path.join(sessionDir, '01-greeting.md')), '--cold: archive file created');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testSaveTopicColdWithoutJSONL() {
  // --cold without JSONL → should error
  const tmpDir = createTempDir();

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'scripts/save-topic.sh'),
    '--cold',
    'greeting',
    'test-session',
    'summary'
  ], {
    encoding: 'utf-8',
    env: { ...process.env, MEMORY_HOME: path.join(tmpDir, 'memory'), CLAUDE_CWD: '/test-project', HOME: tmpDir },
  });

  assert(result.status !== 0, '--cold no JSONL: non-zero exit');
  assert(result.stderr.includes('--cold requires JSONL'), '--cold no JSONL: error message');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testSaveTopicPreservesOriginalStartTime() {
  // When overwriting an existing file, original start time is preserved
  const tmpDir = createTempDir();
  const sessionDir = path.join(tmpDir, 'memory', 'projects', '-test-project', 'test-session');
  fs.mkdirSync(sessionDir, { recursive: true });

  // Create existing topic file with a specific start time
  fs.writeFileSync(path.join(sessionDir, '01-my-topic.md'),
    '# Topic: my-topic\n\n> 2026-01-01 09:00 — 2026-01-01 10:00\n\nOld summary.');

  const claudeProjectDir = path.join(tmpDir, '.claude', 'projects', '-test-project');
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  createFixtureJSONLWithSlug(path.join(claudeProjectDir, 'test-session.jsonl'), 'my-topic');

  const result = spawnSync('bash', [
    path.join(PLUGIN_DIR, 'scripts/save-topic.sh'),
    'my-topic',
    'test-session',
    '## Status\nUpdated summary.'
  ], {
    encoding: 'utf-8',
    env: { ...process.env, MEMORY_HOME: path.join(tmpDir, 'memory'), CLAUDE_CWD: '/test-project', HOME: tmpDir },
  });

  assert(result.status === 0, 'preserve start: exits 0');
  const content = fs.readFileSync(path.join(sessionDir, '01-my-topic.md'), 'utf-8');
  assert(content.includes('2026-01-01 09:00'), 'preserve start: original start time kept');
  assert(content.includes('Updated summary'), 'preserve start: new summary written');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

console.log('');

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
