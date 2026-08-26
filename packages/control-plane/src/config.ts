/**
 * Application configuration, read once from the environment through Effect `Config`
 * so tests can override any of it with `ConfigProvider.fromMap`.
 */
import { Config, Context, Effect, Layer, Redacted } from "effect";
import type { ConversationState } from "@feather-lite/domain";

export interface AppConfigShape {
  readonly databaseUrl: Redacted.Redacted<string>;
  readonly dbMaxConnections: number;
  /** Public identity spoken on every call. */
  readonly agentName: string;
  readonly companyName: string;
  readonly callbackNumber: string;
  /** Per-state LLM model selection (PRD §5.2.2). */
  readonly llmModelByState: Readonly<Record<ConversationState, string>>;
  readonly openaiApiKey: Redacted.Redacted<string> | null;
  readonly openaiBaseUrl: string;
  readonly turnDecider: "scripted" | "openai";
  readonly langfuse: { readonly publicKey: string; readonly secretKey: Redacted.Redacted<string>; readonly baseUrl: string; readonly environment: string } | null;
  /**
   * Kill switch, separate from the keys. A tier-1 load run drives tens of thousands of turns
   * through the scripted decider; `LANGFUSE_ENABLED=false` silences the exporter for that run
   * without anyone having to strip credentials out of .env and put them back afterwards.
   */
  readonly langfuseEnabled: boolean;
  readonly livekit: { readonly url: string; readonly apiKey: string; readonly apiSecret: Redacted.Redacted<string>; readonly agentName: string } | null;
  /** Demo conveniences: clock override on /calls/start, "reset demo" endpoint. */
  readonly demoMode: boolean;
  readonly apiBearerToken: Redacted.Redacted<string> | null;
  /** Public-demo hardening budgets. Raised deliberately for load runs (docs/loadtest/). */
  readonly rateLimitPerMinute: number;
  readonly dailyTurnCap: number;
  /**
   * Orphaned-call sweeper (spec 2026-08-26, D6). A conversation is a candidate once no worker has
   * claimed it for `orphanMissedHeartbeats` heartbeat intervals; the media plane is then asked
   * whether an agent is still in the room, and only a definite "no" finalizes it. When the media
   * plane cannot answer, the much longer `orphanUnconfirmedMs` applies instead, so a LiveKit outage
   * degrades into a slower sweep rather than a fleet-wide hangup.
   */
  readonly sweeperEnabled: boolean;
  readonly orphanMissedHeartbeats: number;
  readonly orphanHeartbeatIntervalMs: number;
  readonly orphanUnconfirmedMs: number;
}

export class AppConfig extends Context.Tag("@feather-lite/AppConfig")<AppConfig, AppConfigShape>() {}

const DEFAULT_MODELS: Readonly<Record<ConversationState, string>> = {
  GREETING: "gpt-4.1-mini",
  VERIFYING_IDENTITY: "gpt-4.1-mini",
  DISCUSSING_PAYMENT: "gpt-4.1",
  CONFIRMING_OUTCOME: "gpt-4.1",
  VOICEMAIL: "gpt-4.1-mini",
  THIRD_PARTY_OR_WRONG_PARTY: "gpt-4.1-mini",
  WARM_TRANSFER_PENDING: "gpt-4.1-mini",
  OPT_OUT: "gpt-4.1-mini",
  WRONG_NUMBER: "gpt-4.1-mini",
  ESCALATED: "gpt-4.1-mini",
  ENDING: "gpt-4.1-mini",
  COMPLETED: "gpt-4.1-mini",
};

const optionalString = (name: string) => Config.string(name).pipe(Config.option);
const optionalRedacted = (name: string) => Config.redacted(name).pipe(Config.option);

export const appConfig: Config.Config<AppConfigShape> = Config.all({
  databaseUrl: Config.redacted("DATABASE_URL").pipe(
    Config.withDefault(Redacted.make("postgres://postgres:postgres@localhost:5434/feather_lite")),
  ),
  dbMaxConnections: Config.integer("DB_MAX_CONNECTIONS").pipe(Config.withDefault(10)),
  agentName: Config.string("AGENT_NAME").pipe(Config.withDefault("Ava")),
  companyName: Config.string("COMPANY_NAME").pipe(Config.withDefault("Feather-Lite Collections")),
  callbackNumber: Config.string("CALLBACK_NUMBER").pipe(Config.withDefault("+1 800 555 0100")),
  llmModelSimple: Config.string("LLM_MODEL_SIMPLE").pipe(Config.withDefault(DEFAULT_MODELS.GREETING)),
  llmModelComplex: Config.string("LLM_MODEL_COMPLEX").pipe(Config.withDefault(DEFAULT_MODELS.DISCUSSING_PAYMENT)),
  openaiApiKey: optionalRedacted("OPENAI_API_KEY"),
  openaiBaseUrl: Config.string("OPENAI_BASE_URL").pipe(Config.withDefault("https://api.openai.com/v1")),
  turnDecider: Config.literal("scripted", "openai")("TURN_DECIDER").pipe(Config.withDefault("scripted" as const)),
  langfusePublicKey: optionalString("LANGFUSE_PUBLIC_KEY"),
  langfuseSecretKey: optionalRedacted("LANGFUSE_SECRET_KEY"),
  langfuseBaseUrl: Config.string("LANGFUSE_BASE_URL").pipe(Config.withDefault("https://cloud.langfuse.com")),
  langfuseEnvironment: Config.string("LANGFUSE_TRACING_ENVIRONMENT").pipe(Config.withDefault("local")),
  langfuseEnabled: Config.boolean("LANGFUSE_ENABLED").pipe(Config.withDefault(true)),
  livekitUrl: optionalString("LIVEKIT_URL"),
  livekitApiKey: optionalString("LIVEKIT_API_KEY"),
  livekitApiSecret: optionalRedacted("LIVEKIT_API_SECRET"),
  livekitAgentName: Config.string("LIVEKIT_AGENT_NAME").pipe(Config.withDefault("feather-lite-agent")),
  demoMode: Config.boolean("DEMO_MODE").pipe(Config.withDefault(true)),
  apiBearerToken: optionalRedacted("API_BEARER_TOKEN"),
  rateLimitPerMinute: Config.integer("RATE_LIMIT_PER_MINUTE").pipe(Config.withDefault(120)),
  dailyTurnCap: Config.integer("DAILY_TURN_CAP").pipe(Config.withDefault(5000)),
  sweeperEnabled: Config.boolean("SWEEPER_ENABLED").pipe(Config.withDefault(true)),
  orphanMissedHeartbeats: Config.integer("ORPHAN_MISSED_HEARTBEATS").pipe(Config.withDefault(3)),
  orphanHeartbeatIntervalMs: Config.integer("ORPHAN_HEARTBEAT_INTERVAL_MS").pipe(Config.withDefault(10_000)),
  orphanUnconfirmedMs: Config.integer("ORPHAN_UNCONFIRMED_MS").pipe(Config.withDefault(300_000)),
}).pipe(
  Config.map((c): AppConfigShape => {
    const models = { ...DEFAULT_MODELS };
    for (const s of Object.keys(models) as ConversationState[]) {
      models[s] = s === "DISCUSSING_PAYMENT" || s === "CONFIRMING_OUTCOME" ? c.llmModelComplex : c.llmModelSimple;
    }
    return {
      databaseUrl: c.databaseUrl,
      dbMaxConnections: c.dbMaxConnections,
      agentName: c.agentName,
      companyName: c.companyName,
      callbackNumber: c.callbackNumber,
      llmModelByState: models,
      openaiApiKey: c.openaiApiKey._tag === "Some" ? c.openaiApiKey.value : null,
      openaiBaseUrl: c.openaiBaseUrl,
      turnDecider: c.turnDecider,
      langfuse:
        c.langfusePublicKey._tag === "Some" && c.langfuseSecretKey._tag === "Some"
          ? { publicKey: c.langfusePublicKey.value, secretKey: c.langfuseSecretKey.value, baseUrl: c.langfuseBaseUrl, environment: c.langfuseEnvironment }
          : null,
      langfuseEnabled: c.langfuseEnabled,
      livekit:
        c.livekitUrl._tag === "Some" && c.livekitApiKey._tag === "Some" && c.livekitApiSecret._tag === "Some"
          ? { url: c.livekitUrl.value, apiKey: c.livekitApiKey.value, apiSecret: c.livekitApiSecret.value, agentName: c.livekitAgentName }
          : null,
      demoMode: c.demoMode,
      apiBearerToken: c.apiBearerToken._tag === "Some" ? c.apiBearerToken.value : null,
      rateLimitPerMinute: c.rateLimitPerMinute,
      dailyTurnCap: c.dailyTurnCap,
      sweeperEnabled: c.sweeperEnabled,
      orphanMissedHeartbeats: c.orphanMissedHeartbeats,
      orphanHeartbeatIntervalMs: c.orphanHeartbeatIntervalMs,
      orphanUnconfirmedMs: c.orphanUnconfirmedMs,
    };
  }),
);

/** Live config from the process environment (and `.env` if the host loaded it). */
export const AppConfigLive: Layer.Layer<AppConfig, import("effect/ConfigError").ConfigError> = Layer.effect(
  AppConfig,
  appConfig,
);

/** Config for tests: overrides on top of defaults. */
export const AppConfigTest = (overrides: Partial<AppConfigShape> = {}): Layer.Layer<AppConfig> =>
  Layer.effect(
    AppConfig,
    Effect.map(appConfig, (base) => ({ ...base, ...overrides })).pipe(Effect.orDie),
  );
