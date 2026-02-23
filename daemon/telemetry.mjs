#!/usr/bin/env node
/**
 * Enterprise Telemetry Collector
 *
 * Runs on the REMOTE (headless) side. Analyzes message patterns,
 * provider usage, failure modes, memory shapes, and timing to
 * generate optimization recommendations for the LOCAL setup.
 *
 * Reads: messages.db, pyramid.db, cost.log
 * Writes: ~/.enterprise/telemetry.json (analysis)
 *         ~/.enterprise/optimizations.json (recommendations)
 *
 * Usage:
 *   node daemon/telemetry.mjs              # analyze once
 *   node daemon/telemetry.mjs --loop       # continuous (every hour)
 */

import initSqlJs from 'sql.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const DATA_DIR = join(homedir(), '.enterprise');
const MSG_DB_PATH = join(DATA_DIR, 'messages.db');
const PYRAMID_DB_PATH = join(DATA_DIR, 'memory', 'pyramid.db');
const COST_LOG_PATH = join(DATA_DIR, 'cost.log');
const TELEMETRY_PATH = join(DATA_DIR, 'telemetry.json');
const OPTIMIZATIONS_PATH = join(DATA_DIR, 'optimizations.json');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const SQL_PROMISE = initSqlJs();

function queryAll(db, sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const r = []; while (stmt.step()) r.push(stmt.getAsObject()); stmt.free(); return r;
}
function queryOne(db, sql, params = []) { return queryAll(db, sql, params)[0] || null; }

// ─── Analyzers ───

function analyzeMessages(db) {
  const total = queryOne(db, 'SELECT COUNT(*) as c FROM messages')?.c || 0;
  const byRole = queryAll(db, 'SELECT role, COUNT(*) as c FROM messages GROUP BY role');
  const byStatus = queryAll(db, 'SELECT status, COUNT(*) as c FROM messages GROUP BY status');
  const threads = queryOne(db, 'SELECT COUNT(*) as c FROM threads')?.c || 0;

  // Provider analysis from metadata
  const withMeta = queryAll(db, "SELECT metadata FROM messages WHERE metadata IS NOT NULL AND metadata != ''");
  const providers = {};
  const processedBy = {};
  const latencies = [];

  for (const row of withMeta) {
    try {
      const meta = JSON.parse(row.metadata);
      if (meta.provider) providers[meta.provider] = (providers[meta.provider] || 0) + 1;
      if (meta.processedBy) processedBy[meta.processedBy] = (processedBy[meta.processedBy] || 0) + 1;
      if (meta.latencyMs) latencies.push(meta.latencyMs);
    } catch {}
  }

  // Error rate
  const errors = queryOne(db, "SELECT COUNT(*) as c FROM messages WHERE status = 'error'")?.c || 0;
  const errorRate = total > 0 ? (errors / total * 100).toFixed(1) : 0;

  // Timing patterns (hour of day distribution)
  const hourly = queryAll(db, `
    SELECT CAST((created_at / 3600000) % 24 AS INTEGER) as hour, COUNT(*) as c
    FROM messages WHERE role = 'user'
    GROUP BY hour ORDER BY hour
  `);

  // Average message length
  const avgLen = queryOne(db, "SELECT AVG(LENGTH(content)) as avg FROM messages WHERE role = 'user'")?.avg || 0;

  // Fallback ratio
  const fallbackCount = processedBy['local'] || 0;
  const remoteCount = Object.values(providers).reduce((a, b) => a + b, 0) - fallbackCount;
  const fallbackRatio = (fallbackCount + remoteCount) > 0
    ? (fallbackCount / (fallbackCount + remoteCount) * 100).toFixed(1)
    : 0;

  return {
    total, threads, byRole, byStatus, providers, processedBy,
    latency: {
      count: latencies.length,
      avg: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
      p50: latencies.length ? latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.5)] : 0,
      p95: latencies.length ? latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)] : 0,
    },
    errorRate: parseFloat(errorRate),
    fallbackRatio: parseFloat(fallbackRatio),
    hourlyDistribution: hourly,
    avgMessageLength: Math.round(avgLen),
  };
}

function analyzeMemory(db) {
  const models = queryAll(db, 'SELECT name, description, is_base, content_dirty FROM models');
  const obsCount = queryOne(db, 'SELECT COUNT(*) as c FROM observations')?.c || 0;
  const summaryCount = queryOne(db, 'SELECT COUNT(*) as c FROM summaries')?.c || 0;
  const unassigned = queryOne(db, 'SELECT COUNT(*) as c FROM observations WHERE model_id IS NULL')?.c || 0;
  const dirtyModels = models.filter(m => m.content_dirty).length;

  // Model sizes
  const modelSizes = models.map(m => {
    const obs = queryOne(db, 'SELECT COUNT(*) as c FROM observations WHERE model_id = (SELECT id FROM models WHERE name = ?)', [m.name])?.c || 0;
    const sums = queryOne(db, 'SELECT COUNT(*) as c FROM summaries WHERE model_id = (SELECT id FROM models WHERE name = ?)', [m.name])?.c || 0;
    return { name: m.name, observations: obs, summaries: sums, isBase: !!m.is_base };
  });

  // Compression ratio
  const compressionRatio = obsCount > 0 && summaryCount > 0 ? (obsCount / summaryCount).toFixed(1) : 'N/A';

  return {
    models: models.length,
    observations: obsCount,
    summaries: summaryCount,
    unassigned,
    dirtyModels,
    compressionRatio,
    modelSizes,
  };
}

function analyzeCosts() {
  if (!existsSync(COST_LOG_PATH)) return { entries: 0, totalCost: 0, avgCostPerRequest: 0 };

  const lines = readFileSync(COST_LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
  let totalCost = 0;
  let totalTokens = 0;
  const daily = {};

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 4) continue;
    const date = parts[0].slice(0, 10);
    const tokens = parseInt(parts[1]) || 0;
    const cost = parseFloat(parts[3]?.replace('$', '')) || 0;
    totalCost += cost;
    totalTokens += tokens;
    daily[date] = (daily[date] || 0) + cost;
  }

  return {
    entries: lines.length,
    totalCost: totalCost.toFixed(4),
    totalTokens,
    avgCostPerRequest: lines.length ? (totalCost / lines.length).toFixed(6) : 0,
    dailyCosts: daily,
  };
}

// ─── Optimization Generator ───

function generateOptimizations(messages, memory, costs) {
  const optimizations = [];

  // 1. Fallback ratio analysis
  if (messages.fallbackRatio > 80) {
    optimizations.push({
      id: 'high-fallback-ratio',
      severity: 'warning',
      category: 'provider',
      title: 'High fallback ratio',
      description: `${messages.fallbackRatio}% of messages are processed by local fallback. The remote LLM is failing most of the time.`,
      recommendation: 'Add an API key to the remote instance (OpenRouter recommended for multi-model access) or install Claude Code on the remote server.',
      script: `# Add OpenRouter to remote\nssh your-vps "cat >> /opt/enterprise/enterprise.env << 'EOF'\nENTERPRISE_PROVIDER=openrouter\nENTERPRISE_API_KEY=sk-or-xxx\nENTERPRISE_MODEL=anthropic/claude-3.5-sonnet\nEOF\nsystemctl restart enterprise"`,
    });
  } else if (messages.fallbackRatio === 0 && messages.total > 10) {
    optimizations.push({
      id: 'no-fallback-needed',
      severity: 'info',
      category: 'provider',
      title: 'Remote processing stable',
      description: 'All messages processed remotely. Local fallback is idle.',
      recommendation: 'Consider reducing fallback bridge poll interval to save resources.',
      script: '# Reduce poll to 30s (from 10s)\nnode daemon/fallback-bridge.mjs --remote URL --token TOKEN --poll 30',
    });
  }

  // 2. Error rate
  if (messages.errorRate > 10) {
    optimizations.push({
      id: 'high-error-rate',
      severity: 'critical',
      category: 'reliability',
      title: 'High error rate',
      description: `${messages.errorRate}% of messages have errors. Check provider configuration.`,
      recommendation: 'Add a fallback chain in headless config. Increase retry count.',
      script: '# Increase retries\nnode daemon/headless.mjs --retries 5 --budget 20',
    });
  }

  // 3. Memory health
  if (memory.unassigned > 20) {
    optimizations.push({
      id: 'unassigned-observations',
      severity: 'warning',
      category: 'memory',
      title: 'Many unassigned observations',
      description: `${memory.unassigned} observations have no mental model. Pyramid sync may be failing.`,
      recommendation: 'Run a manual pyramid sync to assign observations.',
      script: 'npm run pyramid',
    });
  }

  if (memory.dirtyModels > 0 && memory.dirtyModels === memory.models) {
    optimizations.push({
      id: 'all-models-dirty',
      severity: 'warning',
      category: 'memory',
      title: 'All memory models need synthesis',
      description: 'No models have been synthesized. Memory context is empty.',
      recommendation: 'Run pyramid sync to generate MEMORY.md.',
      script: 'npm run pyramid',
    });
  }

  // 4. Compression ratio
  if (memory.compressionRatio !== 'N/A' && parseFloat(memory.compressionRatio) > 15) {
    optimizations.push({
      id: 'low-compression',
      severity: 'info',
      category: 'memory',
      title: 'Memory could be more compressed',
      description: `Compression ratio ${memory.compressionRatio}:1 (observations:summaries). Higher tiers would help.`,
      recommendation: 'Increase pyramid sync frequency to build higher tier summaries.',
      script: 'node daemon/headless.mjs --pyramid-interval 1800',
    });
  }

  // 5. Usage timing → Familiard optimization
  if (messages.hourlyDistribution?.length > 0) {
    const peakHours = messages.hourlyDistribution
      .sort((a, b) => b.c - a.c)
      .slice(0, 3)
      .map(h => h.hour);

    const quietHours = [];
    for (let h = 0; h < 24; h++) {
      if (!messages.hourlyDistribution.find(d => d.hour === h)) quietHours.push(h);
    }

    if (quietHours.length > 8) {
      optimizations.push({
        id: 'quiet-hours-detected',
        severity: 'info',
        category: 'heartbeat',
        title: 'Quiet hours detected',
        description: `No activity during hours: ${quietHours.join(', ')}. Peak: ${peakHours.join(', ')}.`,
        recommendation: 'Configure Familiard to reduce tick frequency during quiet hours.',
        script: `# familiard config.yaml addition\nschedule:\n  quiet_hours: [${quietHours.join(', ')}]\n  quiet_tick_interval: 300  # 5min instead of 60s\n  peak_hours: [${peakHours.join(', ')}]\n  peak_tick_interval: 30    # 30s during peak`,
      });
    }
  }

  // 6. Message length → model selection
  if (messages.avgMessageLength > 2000) {
    optimizations.push({
      id: 'long-messages',
      severity: 'info',
      category: 'provider',
      title: 'Long average messages',
      description: `Average message length: ${messages.avgMessageLength} chars. Consider a model with larger context.`,
      recommendation: 'Use Claude or GPT-4o for long-context conversations.',
      script: '# For OpenRouter, use Claude 3.5 Sonnet (200K context)\nnode daemon/headless.mjs --provider openrouter --model anthropic/claude-3.5-sonnet',
    });
  } else if (messages.avgMessageLength < 200 && messages.total > 20) {
    optimizations.push({
      id: 'short-messages',
      severity: 'info',
      category: 'provider',
      title: 'Short messages — consider faster model',
      description: `Average message length: ${messages.avgMessageLength} chars. A smaller, faster model would save cost.`,
      recommendation: 'Use a faster model for simple Q&A.',
      script: '# Use Haiku for short messages\nnode daemon/headless.mjs --provider openrouter --model anthropic/claude-3-haiku',
    });
  }

  // 7. Cost analysis
  if (costs.entries > 0 && parseFloat(costs.avgCostPerRequest) > 0.05) {
    optimizations.push({
      id: 'high-cost-per-request',
      severity: 'warning',
      category: 'cost',
      title: 'High cost per request',
      description: `Average $${costs.avgCostPerRequest}/request. Consider caching or model downgrade for routine queries.`,
      recommendation: 'Add response caching for repeated queries, or use a smaller model for simple tasks.',
      script: '# Lower budget cap as safety net\nnode daemon/headless.mjs --budget 5',
    });
  }

  // 8. Discovered models → tool suggestions
  if (memory.modelSizes) {
    const discovered = memory.modelSizes.filter(m => !m.isBase && m.observations > 5);
    if (discovered.length > 0) {
      const topTopics = discovered.sort((a, b) => b.observations - a.observations).slice(0, 5);
      optimizations.push({
        id: 'discovered-topics',
        severity: 'info',
        category: 'memory',
        title: 'Discovered knowledge domains',
        description: `Pyramid has auto-discovered ${discovered.length} topics: ${topTopics.map(t => t.name).join(', ')}`,
        recommendation: 'Consider adding Familiard watchers for these topics (git repos, RSS feeds, etc).',
        script: topTopics.map(t =>
          `# Watch for ${t.name} updates\n# familiard config.yaml:\n#   - type: git\n#     name: ${t.name}-watch\n#     repo: <relevant repo URL>`
        ).join('\n\n'),
      });
    }
  }

  return optimizations;
}

// ─── Main ───

async function analyze() {
  console.log('Enterprise Telemetry Analysis');
  console.log('─'.repeat(40));

  const telemetry = { timestamp: new Date().toISOString(), messages: null, memory: null, costs: null };

  // Messages
  if (existsSync(MSG_DB_PATH)) {
    const SQL = await SQL_PROMISE;
    const db = new SQL.Database(readFileSync(MSG_DB_PATH));
    telemetry.messages = analyzeMessages(db);
    db.close();
    console.log(`Messages: ${telemetry.messages.total} total, ${telemetry.messages.errorRate}% error rate, ${telemetry.messages.fallbackRatio}% fallback`);
  } else {
    console.log('Messages: no database');
  }

  // Memory
  if (existsSync(PYRAMID_DB_PATH)) {
    const SQL = await SQL_PROMISE;
    const db = new SQL.Database(readFileSync(PYRAMID_DB_PATH));
    telemetry.memory = analyzeMemory(db);
    db.close();
    console.log(`Memory: ${telemetry.memory.models} models, ${telemetry.memory.observations} observations, ${telemetry.memory.summaries} summaries`);
  } else {
    telemetry.memory = { models: 0, observations: 0, summaries: 0, unassigned: 0, dirtyModels: 0, compressionRatio: 'N/A', modelSizes: [] };
    console.log('Memory: no pyramid database');
  }

  // Costs
  telemetry.costs = analyzeCosts();
  console.log(`Costs: ${telemetry.costs.entries} entries, $${telemetry.costs.totalCost} total`);

  // Save telemetry
  writeFileSync(TELEMETRY_PATH, JSON.stringify(telemetry, null, 2));
  console.log(`\nTelemetry saved: ${TELEMETRY_PATH}`);

  // Generate optimizations
  const optimizations = generateOptimizations(
    telemetry.messages || { total: 0, errorRate: 0, fallbackRatio: 0, hourlyDistribution: [], avgMessageLength: 0 },
    telemetry.memory,
    telemetry.costs,
  );

  writeFileSync(OPTIMIZATIONS_PATH, JSON.stringify({ timestamp: new Date().toISOString(), optimizations }, null, 2));

  console.log(`\nOptimizations (${optimizations.length}):`);
  for (const opt of optimizations) {
    const icon = opt.severity === 'critical' ? '🔴' : opt.severity === 'warning' ? '🟡' : '🔵';
    console.log(`  ${icon} [${opt.category}] ${opt.title}`);
    console.log(`     ${opt.description}`);
    console.log(`     → ${opt.recommendation}`);
  }

  if (!optimizations.length) console.log('  ✓ No optimizations needed');

  console.log(`\nOptimizations saved: ${OPTIMIZATIONS_PATH}`);
  return { telemetry, optimizations };
}

// Loop or once
const loop = process.argv.includes('--loop');
const interval = parseInt(process.argv.find(a => a.startsWith('--interval='))?.split('=')[1] || '3600') * 1000;

if (loop) {
  console.log(`Telemetry running (every ${interval / 1000}s)\n`);
  const tick = async () => {
    try { await analyze(); } catch (e) { console.error(e); }
    setTimeout(tick, interval);
  };
  tick();
} else {
  analyze().catch(console.error);
}
