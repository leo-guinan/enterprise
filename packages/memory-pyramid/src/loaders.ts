/**
 * Loaders — Bootstrap Pyramid from external sources.
 *
 * Sources:
 * - GitHub repos (READMEs, docs, issues, PRs, commit messages)
 * - OpenClaw session logs (JSONL)
 * - Claude conversation exports (JSON)
 * - Raw markdown files
 * - Arbitrary text
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, extname, basename } from 'path';
import type { Message } from './extraction.js';

export interface LoadResult {
  messages: Message[];
  source: string;
  stats: { files: number; messages: number };
}

// ─── GitHub Repo Loader ───

/**
 * Load a GitHub repo (local clone) into conversation-style messages
 * for Pyramid observation extraction.
 *
 * Reads: README, docs/, .md files, recent commits, package.json description
 */
export function loadGitHubRepo(repoPath: string): LoadResult {
  const messages: Message[] = [];
  let fileCount = 0;

  // README
  for (const readme of ['README.md', 'readme.md', 'Readme.md']) {
    const p = join(repoPath, readme);
    if (existsSync(p)) {
      messages.push({
        role: 'assistant',
        content: `Repository README:\n\n${readFileSync(p, 'utf8')}`,
        timestamp: new Date().toISOString(),
      });
      fileCount++;
      break;
    }
  }

  // package.json metadata
  const pkgPath = join(repoPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const meta = [
        pkg.name && `Name: ${pkg.name}`,
        pkg.description && `Description: ${pkg.description}`,
        pkg.keywords?.length && `Keywords: ${pkg.keywords.join(', ')}`,
        pkg.author && `Author: ${typeof pkg.author === 'string' ? pkg.author : pkg.author.name}`,
        pkg.license && `License: ${pkg.license}`,
      ].filter(Boolean).join('\n');
      if (meta) {
        messages.push({ role: 'assistant', content: `Package metadata:\n${meta}`, timestamp: new Date().toISOString() });
        fileCount++;
      }
    } catch {}
  }

  // Markdown files (docs/, top-level, max 50)
  const mdFiles = findMarkdownFiles(repoPath, 3).slice(0, 50);
  for (const mdPath of mdFiles) {
    if (basename(mdPath).toLowerCase().startsWith('readme')) continue; // already loaded
    const content = readFileSync(mdPath, 'utf8');
    if (content.length < 50 || content.length > 50000) continue; // skip trivial or huge
    const relPath = mdPath.replace(repoPath, '').replace(/^\//, '');
    messages.push({
      role: 'assistant',
      content: `File: ${relPath}\n\n${content.slice(0, 10000)}`,
      timestamp: new Date().toISOString(),
    });
    fileCount++;
  }

  // AGENTS.md / SOUL.md / CLAUDE.md (special files)
  for (const special of ['AGENTS.md', 'SOUL.md', 'CLAUDE.md', 'CONTRIBUTING.md']) {
    const p = join(repoPath, special);
    if (existsSync(p) && !mdFiles.includes(p)) {
      messages.push({
        role: 'assistant',
        content: `${special}:\n\n${readFileSync(p, 'utf8').slice(0, 10000)}`,
        timestamp: new Date().toISOString(),
      });
      fileCount++;
    }
  }

  return {
    messages,
    source: `github:${basename(repoPath)}`,
    stats: { files: fileCount, messages: messages.length },
  };
}

/**
 * Load a GitHub repo from URL by cloning it first.
 */
export async function loadGitHubRepoFromUrl(
  repoUrl: string,
  tempDir?: string,
): Promise<LoadResult> {
  const { execSync } = await import('child_process');
  const { mkdtempSync } = await import('fs');
  const { tmpdir } = await import('os');

  const dir = tempDir || mkdtempSync(join(tmpdir(), 'pyramid-repo-'));

  // Shallow clone (fast)
  execSync(`git clone --depth 1 ${repoUrl} ${dir}`, {
    encoding: 'utf8',
    timeout: 60000,
    stdio: 'pipe',
  });

  const result = loadGitHubRepo(dir);
  result.source = `github:${repoUrl}`;
  return result;
}

// ─── OpenClaw Session Loader ───

/**
 * Load OpenClaw session JSONL files into messages.
 * Default path: ~/.openclaw/agents/main/sessions/
 */
export function loadOpenClawSessions(
  sessionsDir?: string,
  limit?: number,
): LoadResult {
  const { homedir } = require('os');
  const dir = sessionsDir || join(homedir(), '.openclaw', 'agents', 'main', 'sessions');

  if (!existsSync(dir)) {
    return { messages: [], source: 'openclaw', stats: { files: 0, messages: 0 } };
  }

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .slice(-(limit || 50)); // most recent

  const messages: Message[] = [];

  for (const file of files) {
    const lines = readFileSync(join(dir, file), 'utf8').trim().split('\n');
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.role && entry.content) {
          messages.push({
            role: entry.role === 'user' ? 'user' : 'assistant',
            content: typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content),
            timestamp: entry.timestamp || entry.created_at || new Date().toISOString(),
          });
        }
      } catch {}
    }
  }

  return {
    messages,
    source: 'openclaw',
    stats: { files: files.length, messages: messages.length },
  };
}

// ─── Claude Export Loader ───

/**
 * Load a Claude conversation export (JSON).
 */
export function loadClaudeExport(filePath: string): LoadResult {
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  const messages: Message[] = [];

  // Claude exports vary in format, handle both array and nested
  const conversations = Array.isArray(raw) ? raw : raw.conversations || [raw];

  for (const convo of conversations) {
    const msgs = convo.messages || convo.chat_messages || [];
    for (const msg of msgs) {
      const role = msg.sender === 'human' || msg.role === 'user' ? 'user' : 'assistant';
      const content = msg.text || msg.content || '';
      if (!content) continue;
      messages.push({
        role,
        content: typeof content === 'string' ? content : JSON.stringify(content),
        timestamp: msg.created_at || msg.timestamp || new Date().toISOString(),
      });
    }
  }

  return {
    messages,
    source: `claude:${basename(filePath)}`,
    stats: { files: 1, messages: messages.length },
  };
}

// ─── Markdown Loader ───

/**
 * Load markdown files from a directory as assistant messages.
 * Good for loading existing MEMORY.md, daily notes, docs.
 */
export function loadMarkdownDir(dirPath: string): LoadResult {
  const files = findMarkdownFiles(dirPath, 3);
  const messages: Message[] = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    if (content.length < 20) continue;
    const relPath = file.replace(dirPath, '').replace(/^\//, '');
    messages.push({
      role: 'assistant',
      content: `${relPath}:\n\n${content.slice(0, 15000)}`,
      timestamp: getFileTimestamp(file),
    });
  }

  return {
    messages,
    source: `markdown:${basename(dirPath)}`,
    stats: { files: files.length, messages: messages.length },
  };
}

// ─── Text Loader ───

/**
 * Load arbitrary text as observations directly.
 * Useful for pasting in context, notes, etc.
 */
export function loadText(text: string, source = 'text'): LoadResult {
  return {
    messages: [{ role: 'assistant', content: text, timestamp: new Date().toISOString() }],
    source,
    stats: { files: 0, messages: 1 },
  };
}

// ─── Helpers ───

function findMarkdownFiles(dir: string, maxDepth: number, depth = 0): string[] {
  if (depth > maxDepth || !existsSync(dir)) return [];

  const results: string[] = [];
  const entries = readdirSync(dir);

  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        results.push(...findMarkdownFiles(full, maxDepth, depth + 1));
      } else if (extname(entry) === '.md') {
        results.push(full);
      }
    } catch {}
  }

  return results;
}

function getFileTimestamp(filePath: string): string {
  try {
    return statSync(filePath).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}
