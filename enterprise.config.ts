/**
 * Enterprise Configuration
 *
 * Single config file that drives both dev (UI + full tooling)
 * and prod (headless, API-only, cost/reliability wrappers).
 *
 * Deploy reads this to generate the headless runtime.
 */

export interface EnterpriseConfig {
  /** Deploy mode */
  mode: 'dev' | 'prod';

  /** Server */
  server: {
    port: number;
    /** Bind address: 127.0.0.1 (local), 0.0.0.0 (LAN/public) */
    bind: string;
    /** Auth token for API access (required in prod) */
    authToken?: string;
  };

  /** LLM provider configuration */
  llm: {
    /** Primary provider: 'claude-max' | 'openai' | 'anthropic' | 'openrouter' | 'ollama' */
    provider: string;
    /** Model identifier */
    model?: string;
    /** API key (for BYOK providers) */
    apiKey?: string;
    /** Base URL override (for ollama, custom endpoints) */
    baseUrl?: string;
    /** Fallback chain: try these if primary fails */
    fallback?: Array<{
      provider: string;
      model?: string;
      apiKey?: string;
      baseUrl?: string;
    }>;
  };

  /** Cost controls */
  cost: {
    /** Daily budget in dollars (0 = unlimited) */
    dailyBudget: number;
    /** Max tokens per request */
    maxTokensPerRequest: number;
    /** Max requests per hour (rate limit) */
    maxRequestsPerHour: number;
    /** Log all costs to this file */
    costLogPath?: string;
  };

  /** Reliability */
  reliability: {
    /** Max retries on LLM failure */
    maxRetries: number;
    /** Retry backoff base (ms) */
    retryBackoffMs: number;
    /** Request timeout (ms) */
    requestTimeoutMs: number;
    /** Circuit breaker: open after N consecutive failures */
    circuitBreakerThreshold: number;
    /** Circuit breaker: reset after this many ms */
    circuitBreakerResetMs: number;
  };

  /** Memory (Pyramid) */
  memory: {
    enabled: boolean;
    /** Path to pyramid workspace */
    workspacePath: string;
    /** Auto-sync interval (seconds, 0 = manual only) */
    syncInterval: number;
  };

  /** Familiard heartbeat */
  familiard: {
    enabled: boolean;
    /** Accept escalations on this endpoint */
    escalationThreadId: string;
  };

  /** Soul configuration */
  soul?: {
    /** Path to SOUL.md */
    path: string;
    /** Injected as system prompt prefix */
    systemPrefix?: string;
  };

  /** Daemon */
  daemon: {
    /** Poll interval for message queue (seconds) */
    pollInterval: number;
    /** Pyramid sync interval (seconds) */
    pyramidSyncInterval: number;
  };
}

/** Default dev config */
export const devDefaults: EnterpriseConfig = {
  mode: 'dev',
  server: { port: 4111, bind: '127.0.0.1' },
  llm: { provider: 'claude-max' },
  cost: { dailyBudget: 0, maxTokensPerRequest: 100000, maxRequestsPerHour: 0 },
  reliability: { maxRetries: 1, retryBackoffMs: 1000, requestTimeoutMs: 120000, circuitBreakerThreshold: 0, circuitBreakerResetMs: 60000 },
  memory: { enabled: true, workspacePath: '~/.enterprise/memory', syncInterval: 600 },
  familiard: { enabled: false, escalationThreadId: 'familiard-escalations' },
  daemon: { pollInterval: 5, pyramidSyncInterval: 600 },
};

/** Default prod config — strict by default */
export const prodDefaults: EnterpriseConfig = {
  mode: 'prod',
  server: { port: 4111, bind: '0.0.0.0', authToken: '' },
  llm: { provider: 'claude-max' },
  cost: { dailyBudget: 10, maxTokensPerRequest: 50000, maxRequestsPerHour: 60 },
  reliability: { maxRetries: 3, retryBackoffMs: 2000, requestTimeoutMs: 120000, circuitBreakerThreshold: 5, circuitBreakerResetMs: 300000 },
  memory: { enabled: true, workspacePath: '~/.enterprise/memory', syncInterval: 3600 },
  familiard: { enabled: true, escalationThreadId: 'familiard-escalations' },
  daemon: { pollInterval: 5, pyramidSyncInterval: 3600 },
};
