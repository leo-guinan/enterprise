#!/usr/bin/env node
/**
 * Sensor Array Extraction
 *
 * Instead of one LLM call for extraction, use many cheap specialized sensors.
 * Each sensor detects one type of signal. Merge + dedup at the end.
 *
 * Sensor types:
 *   - Regex (free, instant): names, numbers, URLs, dates, code refs
 *   - Tiny model (cheap, fast): decisions, preferences, relationships, emotions
 *   - Merge (free): combine, dedup, format as observations
 *
 * Usage:
 *   import { extractWithSensors } from './sensor-array.mjs';
 *   const observations = await extractWithSensors(text);
 *
 * Benchmark:
 *   node daemon/sensor-array.mjs --benchmark
 */

import { execSync } from 'child_process';

const OLLAMA_URL = 'http://localhost:11434';

// ─── Regex Sensors (FREE, instant) ───

function senseNames(text) {
  // Capitalized words that appear after @, or proper nouns in context
  const handles = [...text.matchAll(/@(\w+)/g)].map(m => m[1]);
  const properNouns = [...text.matchAll(/(?:^|[.!?]\s+)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gm)].map(m => m[1]);
  // Names after "by", "from", "with", built by patterns
  const byPatterns = [...text.matchAll(/(?:by|from|with|for)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g)].map(m => m[1]);

  const all = [...new Set([...handles, ...properNouns, ...byPatterns])]
    .filter(n => n.length > 2 && !['The', 'This', 'That', 'What', 'When', 'How', 'But', 'And', 'For', 'Not'].includes(n));

  return all.map(name => ({ type: 'name', value: name, text: `Mentions: ${name}` }));
}

function senseNumbers(text) {
  const observations = [];

  // Dollar amounts
  for (const m of text.matchAll(/\$[\d,.]+[KMBkmb]?/g)) {
    observations.push({ type: 'number', value: m[0], text: `Amount mentioned: ${m[0]}` });
  }

  // Percentages
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) {
    observations.push({ type: 'number', value: `${m[1]}%`, text: `Percentage: ${m[1]}%` });
  }

  // Counts with units
  for (const m of text.matchAll(/(\d+)\s*(days?|hours?|minutes?|seconds?|weeks?|months?|years?|models?|layers?|commits?|files?|lines?|tokens?|observations?|summaries?|users?|requests?)/gi)) {
    observations.push({ type: 'number', value: `${m[1]} ${m[2]}`, text: `Quantity: ${m[1]} ${m[2]}` });
  }

  // Size patterns (3B, 7B, 80B)
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*[BMK](?:\s+(?:param|parameter|model))?/gi)) {
    observations.push({ type: 'number', value: m[0].trim(), text: `Size: ${m[0].trim()}` });
  }

  return observations;
}

function senseURLs(text) {
  const urls = [...text.matchAll(/https?:\/\/[^\s)>\]]+/g)].map(m => m[0]);
  const repos = [...text.matchAll(/(?:github\.com|gitlab\.com)\/[\w-]+\/[\w-]+/g)].map(m => m[0]);
  return [...new Set([...urls, ...repos])].map(url => ({
    type: 'url', value: url, text: `Reference: ${url}`,
  }));
}

function senseDates(text) {
  const observations = [];

  // ISO dates
  for (const m of text.matchAll(/\d{4}-\d{2}-\d{2}/g)) {
    observations.push({ type: 'date', value: m[0], text: `Date: ${m[0]}` });
  }

  // Natural dates
  for (const m of text.matchAll(/((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,?\s+\d{4})?)/gi)) {
    observations.push({ type: 'date', value: m[1], text: `Date: ${m[1]}` });
  }

  // Relative time
  for (const m of text.matchAll(/(?:in|within|next|last)\s+(\d+)\s+(days?|hours?|weeks?|months?)/gi)) {
    observations.push({ type: 'date', value: `${m[1]} ${m[2]}`, text: `Timeframe: ${m[1]} ${m[2]}` });
  }

  return observations;
}

function senseCodeRefs(text) {
  const observations = [];

  // File paths
  for (const m of text.matchAll(/(?:~\/|\.\/|\/[\w-]+\/)?[\w-]+(?:\/[\w-]+)*\.(?:mjs|ts|tsx|js|jsx|py|md|json|yaml|yml|sh|sql|db)/g)) {
    observations.push({ type: 'code', value: m[0], text: `File: ${m[0]}` });
  }

  // npm packages
  for (const m of text.matchAll(/@[\w-]+\/[\w-]+|(?:npm\s+(?:run|install)\s+)([\w-]+)/g)) {
    observations.push({ type: 'code', value: m[0], text: `Package/script: ${m[0]}` });
  }

  // CLI commands
  for (const m of text.matchAll(/(?:^|\n)\s*(?:\$|>)\s*(.+)/g)) {
    observations.push({ type: 'code', value: m[1].trim(), text: `Command: ${m[1].trim()}` });
  }

  return observations;
}

// ─── Tiny Model Sensors (cheap, ~1-2s each) ───

function callTinyModel(prompt, model = 'llama3.2') {
  const body = JSON.stringify({
    model,
    prompt,
    stream: false,
    options: { num_predict: 512, temperature: 0.1 },
  });
  try {
    const raw = execSync(
      `curl -s --max-time 15 -X POST ${OLLAMA_URL}/api/generate -d '${body.replace(/'/g, "'\\''")}'`,
      { encoding: 'utf8', timeout: 20000, maxBuffer: 5 * 1024 * 1024 }
    );
    return JSON.parse(raw).response || '';
  } catch { return ''; }
}

function senseDecisions(text) {
  const response = callTinyModel(
    `Extract ONLY the decisions or commitments made in this text. Output one per line, no bullets, no numbering. If none, output "NONE".

Text: ${text.slice(0, 3000)}`
  );
  if (!response || response.includes('NONE')) return [];
  return response.split('\n')
    .map(l => l.replace(/^[-•*\d.)\s]+/, '').trim())
    .filter(l => l.length > 10 && l.length < 300)
    .map(d => ({ type: 'decision', value: d, text: `Decision: ${d}` }));
}

function sensePreferences(text) {
  const response = callTinyModel(
    `Extract ONLY user preferences, wants, or opinions from this text. Output one per line. If none, output "NONE".

Text: ${text.slice(0, 3000)}`
  );
  if (!response || response.includes('NONE')) return [];
  return response.split('\n')
    .map(l => l.replace(/^[-•*\d.)\s]+/, '').trim())
    .filter(l => l.length > 10 && l.length < 300)
    .map(p => ({ type: 'preference', value: p, text: `Preference: ${p}` }));
}

function senseRelationships(text) {
  const response = callTinyModel(
    `Extract ONLY relationships between entities (X built Y, X integrates with Y, X depends on Y, X is part of Y). Output one per line as "ENTITY1 → RELATION → ENTITY2". If none, output "NONE".

Text: ${text.slice(0, 3000)}`
  );
  if (!response || response.includes('NONE')) return [];
  return response.split('\n')
    .map(l => l.replace(/^[-•*\d.)\s]+/, '').trim())
    .filter(l => l.includes('→') && l.length > 10)
    .map(r => ({ type: 'relationship', value: r, text: `Relationship: ${r}` }));
}

function senseFacts(text) {
  const response = callTinyModel(
    `Extract ONLY concrete facts (specific names, numbers, technical details) from this text. One fact per line. Be extremely specific. If none, output "NONE".

Text: ${text.slice(0, 3000)}`
  );
  if (!response || response.includes('NONE')) return [];
  return response.split('\n')
    .map(l => l.replace(/^[-•*\d.)\s]+/, '').trim())
    .filter(l => l.length > 10 && l.length < 300)
    .map(f => ({ type: 'fact', value: f, text: f }));
}

// ─── Merge + Dedup ───

function mergeAndDedup(allSignals) {
  const seen = new Set();
  const observations = [];

  for (const signal of allSignals) {
    // Dedup by normalized text
    const key = signal.text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) continue;

    // Skip very short or generic
    if (signal.text.length < 15) continue;

    seen.add(key);
    observations.push({
      text: signal.text,
      type: signal.type,
      timestamp: new Date().toISOString(),
    });
  }

  return observations;
}

// ─── Main Export ───

export function extractWithSensors(text, options = {}) {
  const {
    useRegex = true,
    useTinyModel = true,
    model = 'llama3.2',
  } = options;

  const signals = [];
  const timing = {};

  // Regex sensors (free, instant)
  if (useRegex) {
    let start = Date.now();
    signals.push(...senseNames(text));
    timing.names = Date.now() - start;

    start = Date.now();
    signals.push(...senseNumbers(text));
    timing.numbers = Date.now() - start;

    start = Date.now();
    signals.push(...senseURLs(text));
    timing.urls = Date.now() - start;

    start = Date.now();
    signals.push(...senseDates(text));
    timing.dates = Date.now() - start;

    start = Date.now();
    signals.push(...senseCodeRefs(text));
    timing.codeRefs = Date.now() - start;
  }

  // Tiny model sensors
  if (useTinyModel) {
    let start = Date.now();
    signals.push(...senseDecisions(text));
    timing.decisions = Date.now() - start;

    start = Date.now();
    signals.push(...sensePreferences(text));
    timing.preferences = Date.now() - start;

    start = Date.now();
    signals.push(...senseRelationships(text));
    timing.relationships = Date.now() - start;

    start = Date.now();
    signals.push(...senseFacts(text));
    timing.facts = Date.now() - start;
  }

  const observations = mergeAndDedup(signals);

  return {
    observations,
    stats: {
      rawSignals: signals.length,
      afterDedup: observations.length,
      byType: Object.fromEntries(
        [...new Set(signals.map(s => s.type))].map(t => [t, signals.filter(s => s.type === t).length])
      ),
      timing,
      totalMs: Object.values(timing).reduce((a, b) => a + b, 0),
    },
  };
}

// ─── Benchmark ───

if (process.argv.includes('--benchmark')) {
  const SAMPLE = `We just built an open-source ChatGPT alternative in one session. The architecture splits cleanly:

LOCAL (your machine): Claude Max brain (free, unlimited), private data + filesystem tools, Familiard sentinel (Ollama, cheap), Pyramid memory (observations → summaries → mental models).

REMOTE (VPS/cloud): API routing + message queue, cost tracking + circuit breaker, fallback coordination, always-on reliability.

When the remote can't process a message (no LLM, out of budget, circuit breaker open), it queues it for your local machine. Your Mac picks it up, processes via Claude Max (free), and pushes the response back.

Memory is pyramidal (port of @finereli's pyramid): Conversations → extract observations → assign to mental models → compress into tiered summaries → synthesize narratives → MEMORY.md. Each conversation makes the next one smarter.

Heartbeat uses @liet-codes's Familiard: Local Ollama classifies events (filesystem, git, email). 90% ignored. 9% logged. 1% escalated to cloud agent.

We're building on @mastra's framework. Live: https://enterprise.metaspn.network/api/health. Code: github.com/leo-guinan/enterprise.

Built in 45 minutes. 10 commits. 38.4MB RAM on VPS. Challenge: make it @janwilmake's daily driver in 7 days.`;

  console.log('Sensor Array Benchmark');
  console.log('═'.repeat(60));

  // Regex only
  console.log('\n▶ Regex sensors only (FREE):');
  let start = Date.now();
  const regexResult = extractWithSensors(SAMPLE, { useTinyModel: false });
  console.log(`  Signals: ${regexResult.stats.rawSignals}  Observations: ${regexResult.stats.afterDedup}  Time: ${Date.now() - start}ms`);
  console.log(`  Types: ${JSON.stringify(regexResult.stats.byType)}`);
  for (const obs of regexResult.observations.slice(0, 10)) {
    console.log(`    [${obs.type}] ${obs.text}`);
  }

  // Regex + tiny model
  console.log('\n▶ Full sensor array (regex + 3B model):');
  start = Date.now();
  const fullResult = extractWithSensors(SAMPLE);
  const totalMs = Date.now() - start;
  console.log(`  Signals: ${fullResult.stats.rawSignals}  Observations: ${fullResult.stats.afterDedup}  Time: ${totalMs}ms`);
  console.log(`  Types: ${JSON.stringify(fullResult.stats.byType)}`);
  console.log(`  Timing: ${JSON.stringify(fullResult.stats.timing)}`);
  for (const obs of fullResult.observations) {
    console.log(`    [${obs.type}] ${obs.text}`);
  }

  // Compare with single LLM call
  console.log('\n▶ Single LLM extraction (3B model, old method):');
  start = Date.now();
  const body = JSON.stringify({
    model: 'llama3.2',
    prompt: `Extract specific factual observations from this text. Return a JSON array of objects with "text" (single factual sentence) fields. Only output the JSON array.\n\n${SAMPLE}`,
    stream: false,
    options: { num_predict: 2048 },
  });
  try {
    const raw = execSync(
      `curl -s --max-time 30 -X POST ${OLLAMA_URL}/api/generate -d '${body.replace(/'/g, "'\\''")}'`,
      { encoding: 'utf8', timeout: 35000 }
    );
    const response = JSON.parse(raw).response;
    const match = response.match(/\[[\s\S]*\]/);
    const arr = match ? JSON.parse(match[0]) : [];
    console.log(`  Observations: ${arr.length}  Time: ${Date.now() - start}ms`);
    for (const obs of arr.slice(0, 10)) {
      console.log(`    ${obs.text}`);
    }
  } catch (e) {
    console.log(`  Failed: ${e.message}`);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('COMPARISON');
  console.log('═'.repeat(60));
  console.log(`  Regex only:     ${regexResult.stats.afterDedup} obs, ~0ms, $0`);
  console.log(`  Sensor array:   ${fullResult.stats.afterDedup} obs, ${totalMs}ms, $0`);
  console.log(`  Sensor array captures structured signals (names, numbers, URLs, dates)`);
  console.log(`  PLUS semantic signals (decisions, preferences, relationships, facts)`);
  console.log(`  Each sensor is independently testable and replaceable`);
}
