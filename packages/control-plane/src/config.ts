import { Config, Context, Effect, Layer, Redacted } from "effect";
import type { ConversationState } from "@feather-lite/domain";

export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface AppConfigShape {
  readonly databaseUrl: Redacted.Redacted<string>;
  readonly dbMaxConnections: number;
  readonly agentName: string;
  readonly companyName: string;
  readonly callbackNumber: string;
  readonly llmModelByState: Readonly<Record<ConversationState, string>>;
  readonly openaiApiKey: Redacted.Redacted<string> | null;
  readonly openaiBaseUrl: string;
  readonly turnDecider: "scripted" | "openai";
  readonly langfuse: { readonly publicKey: string; readonly secretKey: Redacted.Redacted<string>; readonly baseUrl: string; readonly environment: string } | null;
  readonly langfuseEnabled: boolean;
  readonly traceRedactAccountData: boolean;
  readonly livekit:
    | { readonly url: string; readonly apiKey: string; readonly apiSecret: Redacted.Redacted<string>; readonly agentName: string; readonly sipOutboundTrunkId: string | null }
    | null;
  readonly demoMode: boolean;
  readonly apiBearerToken: Redacted.Redacted<string> | null;
  readonly rateLimitBypassToken: Redacted.Redacted<string> | null;
  readonly rateLimitPerMinute: number;
  readonly dailyTurnCap: number;
  readonly sweeperEnabled: boolean;
  readonly orphanMissedHeartbeats: number;
  readonly orphanHeartbeatIntervalMs: number;
  readonly orphanUnconfirmedMs: number;
  /**
   * The judge model id is spelled out in full rather than the bare `gpt-5.6` alias, which OpenAI
   * routes to the frontier tier and costs an order of magnitude more per call.
   */
  readonly judge: {
    readonly enabled: boolean;
    readonly model: string;
    readonly reasoningEffort: ReasoningEffort;
    readonly maxTokens: number;
  };
  readonly slo: {
    readonly turnP95Ms: number;
    readonly eouP95Ms: number;
    readonly transcriptionP95Ms: number;
    readonly ttftP95Ms: number;
    readonly ttsTtfbP95Ms: number;
    readonly minSample: number;
  };
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
  traceRedactAccountData: Config.boolean("TRACE_REDACT_ACCOUNT_DATA").pipe(Config.withDefault(true)),
  livekitUrl: optionalString("LIVEKIT_URL"),
  livekitApiKey: optionalString("LIVEKIT_API_KEY"),
  livekitApiSecret: optionalRedacted("LIVEKIT_API_SECRET"),
  livekitAgentName: Config.string("LIVEKIT_AGENT_NAME").pipe(Config.withDefault("feather-lite-agent")),
  livekitSipOutboundTrunkId: optionalString("LIVEKIT_SIP_OUTBOUND_TRUNK_ID"),
  demoMode: Config.boolean("DEMO_MODE").pipe(Config.withDefault(true)),
  apiBearerToken: optionalRedacted("API_BEARER_TOKEN"),
  rateLimitBypassToken: optionalRedacted("RATE_LIMIT_BYPASS_TOKEN"),
  rateLimitPerMinute: Config.integer("RATE_LIMIT_PER_MINUTE").pipe(Config.withDefault(120)),
  dailyTurnCap: Config.integer("DAILY_TURN_CAP").pipe(Config.withDefault(5000)),
  sweeperEnabled: Config.boolean("SWEEPER_ENABLED").pipe(Config.withDefault(true)),
  orphanMissedHeartbeats: Config.integer("ORPHAN_MISSED_HEARTBEATS").pipe(Config.withDefault(3)),
  orphanHeartbeatIntervalMs: Config.integer("ORPHAN_HEARTBEAT_INTERVAL_MS").pipe(Config.withDefault(10_000)),
  orphanUnconfirmedMs: Config.integer("ORPHAN_UNCONFIRMED_MS").pipe(Config.withDefault(300_000)),
  judgeEnabled: Config.boolean("JUDGE_ENABLED").pipe(Config.withDefault(false)),
  judgeModel: Config.string("JUDGE_MODEL").pipe(Config.withDefault("gpt-5.6-luna")),
  judgeReasoningEffort: Config.literal(...REASONING_EFFORTS)("JUDGE_REASONING_EFFORT").pipe(Config.withDefault("medium" as const)),
  // Reasoning tokens are billed and counted here, and the visible answer is ~600 tokens of JSON.
  judgeMaxTokens: Config.integer("JUDGE_MAX_TOKENS").pipe(Config.withDefault(4000)),
  sloTurnP95Ms: Config.integer("SLO_TURN_P95_MS").pipe(Config.withDefault(2500)),
  sloEouP95Ms: Config.integer("SLO_EOU_P95_MS").pipe(Config.withDefault(700)),
  sloTranscriptionP95Ms: Config.integer("SLO_TRANSCRIPTION_P95_MS").pipe(Config.withDefault(600)),
  sloTtftP95Ms: Config.integer("SLO_TTFT_P95_MS").pipe(Config.withDefault(1500)),
  sloTtsTtfbP95Ms: Config.integer("SLO_TTS_TTFB_P95_MS").pipe(Config.withDefault(600)),
  sloMinSample: Config.integer("SLO_MIN_SAMPLE").pipe(Config.withDefault(20)),
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
      traceRedactAccountData: c.traceRedactAccountData,
      livekit:
        c.livekitUrl._tag === "Some" && c.livekitApiKey._tag === "Some" && c.livekitApiSecret._tag === "Some"
          ? {
              url: c.livekitUrl.value,
              apiKey: c.livekitApiKey.value,
              apiSecret: c.livekitApiSecret.value,
              agentName: c.livekitAgentName,
              sipOutboundTrunkId: c.livekitSipOutboundTrunkId._tag === "Some" && c.livekitSipOutboundTrunkId.value.length > 0 ? c.livekitSipOutboundTrunkId.value : null,
            }
          : null,
      demoMode: c.demoMode,
      /**
       * Blank must read as absent: `API_BEARER_TOKEN=` parses as `Some("")`, which switches
       * authentication on with an empty secret and 401s every real client, including the worker.
       */
      apiBearerToken: c.apiBearerToken._tag === "Some" && Redacted.value(c.apiBearerToken.value).length > 0 ? c.apiBearerToken.value : null,
      rateLimitBypassToken: c.rateLimitBypassToken._tag === "Some" && Redacted.value(c.rateLimitBypassToken.value).length > 0 ? c.rateLimitBypassToken.value : null,
      rateLimitPerMinute: c.rateLimitPerMinute,
      dailyTurnCap: c.dailyTurnCap,
      sweeperEnabled: c.sweeperEnabled,
      orphanMissedHeartbeats: c.orphanMissedHeartbeats,
      orphanHeartbeatIntervalMs: c.orphanHeartbeatIntervalMs,
      orphanUnconfirmedMs: c.orphanUnconfirmedMs,
      judge: {
        enabled: c.judgeEnabled,
        model: c.judgeModel,
        reasoningEffort: c.judgeReasoningEffort,
        maxTokens: c.judgeMaxTokens,
      },
      slo: {
        turnP95Ms: c.sloTurnP95Ms,
        eouP95Ms: c.sloEouP95Ms,
        transcriptionP95Ms: c.sloTranscriptionP95Ms,
        ttftP95Ms: c.sloTtftP95Ms,
        ttsTtfbP95Ms: c.sloTtsTtfbP95Ms,
        minSample: c.sloMinSample,
      },
    };
  }),
);

export const AppConfigLive: Layer.Layer<AppConfig, import("effect/ConfigError").ConfigError> = Layer.effect(
  AppConfig,
  appConfig,
);

export const AppConfigTest = (overrides: Partial<AppConfigShape> = {}): Layer.Layer<AppConfig> =>
  Layer.effect(
    AppConfig,
    Effect.map(appConfig, (base) => ({ ...base, ...overrides })).pipe(Effect.orDie),
  );
