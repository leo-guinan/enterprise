#!/usr/bin/env node
/**
 * Enterprise Deploy
 *
 * Packages the headless runtime for remote deployment.
 *
 * Usage:
 *   node deploy.mjs --output ./dist-headless          # package to directory
 *   node deploy.mjs --output ./dist-headless --tar     # package as tarball
 *   node deploy.mjs --ssh user@host:/opt/enterprise    # deploy via SSH
 *
 * The output contains:
 *   - daemon/headless.mjs (single-process runtime)
 *   - daemon/pyramid-sync.mjs (memory pipeline)
 *   - daemon/pyramid-load.mjs (bootloader)
 *   - package.json (minimal, production deps only)
 *   - enterprise.env.example (config template)
 *   - Dockerfile (optional container deploy)
 *   - systemd/enterprise.service (optional systemd unit)
 */

import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { execSync } from 'child_process';

const args = process.argv.slice(2);
function getArg(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? (args[idx + 1] || fallback) : fallback;
}
const hasFlag = (f) => args.includes(f);

const OUTPUT = getArg('--output', './dist-headless');
const SSH_TARGET = getArg('--ssh', '');
const AS_TAR = hasFlag('--tar');

console.log(`Enterprise Deploy → ${SSH_TARGET || OUTPUT}`);

// ─── Package ───

mkdirSync(join(OUTPUT, 'daemon'), { recursive: true });
mkdirSync(join(OUTPUT, 'systemd'), { recursive: true });

// Copy daemon files
for (const f of ['daemon/headless.mjs', 'daemon/pyramid-sync.mjs', 'daemon/pyramid-load.mjs', 'daemon/fallback-bridge.mjs']) {
  copyFileSync(f, join(OUTPUT, f));
}

// Minimal package.json
writeFileSync(join(OUTPUT, 'package.json'), JSON.stringify({
  name: 'enterprise-headless',
  version: '0.1.0',
  type: 'module',
  scripts: {
    start: 'node daemon/headless.mjs',
    'pyramid:sync': 'node daemon/pyramid-sync.mjs',
    'pyramid:load': 'node daemon/pyramid-load.mjs',
  },
  dependencies: {
    'sql.js': '^1.11.0',
  },
}, null, 2));

// Env template
writeFileSync(join(OUTPUT, 'enterprise.env.example'), `# Enterprise Headless Configuration
# Copy to enterprise.env and edit

# Auth token (required for remote access)
ENTERPRISE_AUTH_TOKEN=changeme

# LLM Provider: claude-max | openai | anthropic | openrouter | ollama
# ENTERPRISE_PROVIDER=claude-max
# ENTERPRISE_MODEL=
# ENTERPRISE_API_KEY=

# Cost controls
# ENTERPRISE_DAILY_BUDGET=10
# ENTERPRISE_RATE_LIMIT=60

# Soul
# ENTERPRISE_SOUL_PATH=/opt/enterprise/SOUL.md
`);

// Dockerfile
writeFileSync(join(OUTPUT, 'Dockerfile'), `FROM node:22-slim
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY daemon/ daemon/
COPY enterprise.env.example .

# Install Claude Code CLI (for claude-max provider)
# RUN npm install -g @anthropic-ai/claude-code

ENV NODE_ENV=production
EXPOSE 4111

CMD ["node", "daemon/headless.mjs"]
`);

// systemd unit
writeFileSync(join(OUTPUT, 'systemd/enterprise.service'), `[Unit]
Description=Enterprise Headless Runtime
After=network.target

[Service]
Type=simple
User=enterprise
WorkingDirectory=/opt/enterprise
EnvironmentFile=/opt/enterprise/enterprise.env
ExecStart=/usr/bin/node daemon/headless.mjs
Restart=always
RestartSec=5

# Cost safety: kill if using too much memory
MemoryMax=512M
# Restart daily to reset cost counters cleanly
RuntimeMaxSec=86400

[Install]
WantedBy=multi-user.target
`);

// README
writeFileSync(join(OUTPUT, 'README.md'), `# Enterprise Headless

Production runtime for The Enterprise. No UI, API only.

## Quick Start

\`\`\`bash
cp enterprise.env.example enterprise.env
# Edit enterprise.env with your auth token + provider config

npm install
npm start
\`\`\`

## Deploy via systemd

\`\`\`bash
sudo cp systemd/enterprise.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable enterprise
sudo systemctl start enterprise
\`\`\`

## Deploy via Docker

\`\`\`bash
docker build -t enterprise .
docker run -d -p 4111:4111 --env-file enterprise.env enterprise
\`\`\`

## API

All endpoints require \`Authorization: Bearer <token>\` except /api/health.

| Endpoint | Method | Description |
|----------|--------|-------------|
| /api/health | GET | Health + cost + circuit status |
| /api/status | GET | Daemon status |
| /api/threads | GET/POST | List/create threads |
| /api/threads/:id/messages | GET/POST | List/send messages |
| /api/familiard/escalate | POST | Receive Familiard escalations |
| /api/pyramid/status | GET | Memory stats |
| /api/cost | GET | Cost tracking |

## Bootload Memory

\`\`\`bash
npm run pyramid:load -- --github https://github.com/user/repo
npm run pyramid:sync
\`\`\`

## CLI Options

\`\`\`
--port 4111              Server port
--bind 0.0.0.0           Bind address
--auth TOKEN             Auth token
--budget 10              Daily budget ($)
--rate-limit 60          Max requests/hour
--retries 3              LLM retry count
--provider claude-max    LLM provider
--model MODEL            Model name
--api-key KEY            API key (BYOK)
--memory PATH            Pyramid workspace path
--soul PATH              SOUL.md path
--poll 5                 Queue poll interval (seconds)
--pyramid-interval 3600  Pyramid sync interval (seconds)
\`\`\`
`);

console.log(`✓ Packaged to ${OUTPUT}/`);
console.log(`  Files: headless.mjs, pyramid-sync.mjs, pyramid-load.mjs`);
console.log(`  Config: enterprise.env.example, Dockerfile, systemd unit`);

// ─── SSH Deploy ───

if (SSH_TARGET) {
  console.log(`\nDeploying to ${SSH_TARGET}...`);
  try {
    const [host, path] = SSH_TARGET.includes(':') ? SSH_TARGET.split(':') : [SSH_TARGET, '/opt/enterprise'];
    execSync(`rsync -avz --delete ${OUTPUT}/ ${host}:${path}/`, { stdio: 'inherit' });
    execSync(`ssh ${host} "cd ${path} && npm install --production"`, { stdio: 'inherit' });
    console.log(`✓ Deployed to ${host}:${path}`);
    console.log(`  Next: ssh ${host} "cd ${path} && node daemon/headless.mjs"`);
  } catch (e) {
    console.error('Deploy failed:', e.message);
    process.exit(1);
  }
}

// ─── Tarball ───

if (AS_TAR) {
  const tarName = `enterprise-headless-${new Date().toISOString().slice(0, 10)}.tar.gz`;
  execSync(`tar -czf ${tarName} -C ${OUTPUT} .`);
  console.log(`\n✓ Tarball: ${tarName}`);
}
