# Graph Report - QwenProxy  (2026-10-05)

## Corpus Check
- 362 files · ~383,895 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 8 file(s) not represented in the graph (top: (none) 4, .bat 3, .example 1)

## Summary
- 3499 nodes · 9888 edges · 137 communities (113 shown, 22 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 115 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `89953053`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- account-concurrency.ts
- MaintenanceScheduler
- retry-coordinator.ts
- generation-repository.ts
- soak.test.ts
- accounts.ts
- qwen.ts
- tool-integrity-stress.test.ts
- playwright.ts
- AccountResourceManager
- proxy-baseline.ts
- maintenance-clients.test.ts
- chat/streaming.ts
- context-service.ts
- media-generation.ts
- core/errors.ts
- account-manager.ts
- maskEmail
- sync/index.ts
- qwenUrl
- account-health.ts
- MemoryCache
- migrations.ts
- config.ts
- anthropic/index.ts
- chat/index.ts
- parser.ts
- browser-session-manager.ts
- model-registry.ts
- captcha-solver.ts
- tui.test.ts
- session-repository.ts
- server.ts
- hono
- event-recorder.ts
- QwenProxy
- StreamingToolParser
- session-keeper.ts
- retry-policy.ts
- instance.ts
- stream-registry.ts
- app.ts
- Screen
- generation-coordinator.ts
- StreamManager
- chat/context.ts
- instructions.ts
- StressDriver
- FakeOwnership
- robustParseJSON
- account-pool-readiness.integration.test.ts
- context-meter.ts
- egress.ts
- forge-import.test.ts
- adapter.ts
- responses/types.ts
- warmup-stress.test.ts
- qwen-chat-pool.ts
- stickyMap.ts
- upload.ts
- ServerProcess
- toolcall-tags.ts
- tiered.ts
- logger.ts
- chat/validation.ts
- generation-coordinator.test.ts
- message-repository.ts
- ReadinessController
- fingerprint.ts
- scripts
- paths.ts
- account.ts
- browser-process-cleanup.ts
- responses/index.ts
- syncQwenRequestPersonalization
- parser-truncated-tool-call.test.ts
- FakeOwnership
- package.json
- storage-view.ts
- responses/validation.ts
- context-stress.test.ts
- compilerOptions
- config-check.mjs
- Mutex
- maintenance-scheduler.ts
- driver.ts
- OperationRegistry
- metrics-emitter.ts
- health.ts
- ChatView
- qwenproxy.js
- qwen-thread-state.ts
- CONFIG.md — every runtime env var (Phase 3.3)
- ServerManager
- HealthTracker
- initPlaywrightForAccount
- .tryRecoverToolCall
- dependencies
- update-cli.ts
- AccountsView
- broken-recovery.test.ts
- getDatabase
- chat-cleanup.ts
- PerformanceView
- account-scheduler.ts
- OPERATIONS.md — QwenProxy runbook (Phase 3.3)
- latency-optimizations.test.ts
- auth-playwright.ts
- models.ts
- performanceMetrics
- context-compressor.ts
- devDependencies
- StatusView
- ali-oss.d.ts
- SECURITY.md — threat model & controls (Phase 3.3)
- IAccountOwnership
- logical-thread-batch.test.ts
- request-path-no-cold-init.test.ts
- cli.test.ts
- test-contract.mjs
- repository
- docker-entrypoint.sh
- TuiApp
- shared-browser.test.ts
- readiness-controller.ts
- engines
- install.sh
- start.sh
- update.sh
- STRESS_RESULT
- STRESS_RESULT
- STRESS_RESULT
- STRESS_RESULT
- STRESS_RESULT
- parser.test.ts

## God Nodes (most connected - your core abstractions)
1. `getDatabase()` - 108 edges
2. `tryCreateStreamWithRetry()` - 63 edges
3. `Config` - 59 edges
4. `qwenUrl()` - 58 edges
5. `StreamingToolParser` - 54 edges
6. `processStreamingResponse()` - 50 edges
7. `loadAccounts()` - 49 edges
8. `invalidateAccountsCache()` - 43 edges
9. `chatCompletions()` - 42 edges
10. `logger` - 39 edges

## Surprising Connections (you probably didn't know these)
- `snapshotAccounts()` --calls--> `getDatabase()`  [EXTRACTED]
  src/tests/accounts-security.test.ts → src/core/database.ts
- `makeAttempt()` --calls--> `nextAttempt()`  [EXTRACTED]
  src/tests/stress/tool-integrity-stress.test.ts → src/domain/generation.ts
- `FakeAccount` --references--> `AccountStatus`  [EXTRACTED]
  src/runtime/readiness/maintenance-clients.test.ts → src/domain/types.ts
- `FakeAccount` --references--> `AccountStatus`  [EXTRACTED]
  src/runtime/readiness/readiness-controller.test.ts → src/domain/types.ts
- `bindPool()` --calls--> `initAccountOwnership()`  [EXTRACTED]
  src/tests/account-pool-readiness.integration.test.ts → src/runtime/account/instance.ts

## Import Cycles
- 2-file cycle: `src/services/qwen-chat-pool.ts -> src/services/qwen.ts -> src/services/qwen-chat-pool.ts`

## Communities (137 total, 22 thin omitted)

### Community 0 - "account-concurrency.ts"
Cohesion: 0.14
Nodes (28): abortLeaseByLabel(), AccountLease, AccountSlot, acquireAccountLease(), AcquireAccountLeaseOptions, acquireBound(), ActiveLeaseInfo, claimBound() (+20 more)

### Community 1 - "MaintenanceScheduler"
Cohesion: 0.16
Nodes (4): newJobId(), MaintenanceScheduler, SessionKeeperClients, recoverPool()

### Community 2 - "retry-coordinator.ts"
Cohesion: 0.08
Nodes (24): CONTEXT_BUDGET_ERRORS, ErrorCode, HTTP_STATUS_BY_ERROR_CODE, isContextBudgetError(), isTerminalGenerationError(), LEGACY_TO_ERROR_CODE, TERMINAL_GENERATION_ERRORS, AcquireRejection (+16 more)

### Community 3 - "generation-repository.ts"
Cohesion: 0.06
Nodes (43): SideEffectRecord, newAttemptId(), newEventId(), newGenerationId(), newLeaseId(), newMessageId(), newOperationId(), newOwnerToken() (+35 more)

### Community 4 - "soak.test.ts"
Cohesion: 0.10
Nodes (26): counters, FAIL_MODES, Mix, MIXES, recorder, SCENARIO_NAME, FailMode, flushEvents() (+18 more)

### Community 5 - "accounts.ts"
Cohesion: 0.07
Nodes (36): accounts, cols, db, sessions, getCachedAccounts(), parseEnvAccounts(), syncEnvAccounts(), DATA_DIR (+28 more)

### Community 6 - "qwen.ts"
Cohesion: 0.05
Nodes (58): onBrowserContextCreated(), accountStreamMutexes, AccountStreamSlots, acquireAccountStreamLock(), activePersonalizationByAccount, addIdleTimeoutToStream(), browserStreamBindingContexts, browserStreamBindingPages (+50 more)

### Community 7 - "tool-integrity-stress.test.ts"
Cohesion: 0.10
Nodes (20): assertToolRoundStructurallyValid(), canonicalizeToolArguments(), isToolRoundComplete(), sortKeys(), ToolCallEvent, toolCallFingerprint(), ToolCallStatus, ToolDefinition (+12 more)

### Community 8 - "playwright.ts"
Cohesion: 0.03
Nodes (90): setWafContextResetListener(), AccountActivationBlock, accountCancelControllers, accountContexts, AccountHeaderCache, accountMutexes, accountPages, ACTIVATION_CONTEXT_MARKERS (+82 more)

### Community 9 - "AccountResourceManager"
Cohesion: 0.09
Nodes (18): AccountResourceManager, now(), registerReady(), ACCOUNT_TERMINAL_STATES, assertAccountTransition(), canTransitionAccount(), describeTransition(), exhaustiveCheck() (+10 more)

### Community 10 - "proxy-baseline.ts"
Cohesion: 0.08
Nodes (53): AccountBenchmarkContext, BENCH_RUN_ID, BenchmarkConfig, benchmarkNonStream(), BenchmarkReport, benchmarkStream(), buildAccountBenchmarkContext(), buildChatBody() (+45 more)

### Community 11 - "maintenance-clients.test.ts"
Cohesion: 0.14
Nodes (19): ensurePoolReadiness(), ReadinessControllerClients, registerReadinessControllerClients(), resetReadinessControllerClientsForTests(), resetRuntimeServicesForTests(), RuntimeServices, startRuntimeServices(), StartRuntimeServicesOptions (+11 more)

### Community 12 - "chat/streaming.ts"
Cohesion: 0.13
Nodes (37): markAccountTemporarilyBusy(), updateStreamSessionId(), updateStreamTargetResponseId(), isWafChallenge(), ParsedQwenErrorPayload, parseQwenErrorPayload(), applyUpstreamUsage(), asFiniteNumber() (+29 more)

### Community 13 - "context-service.ts"
Cohesion: 0.07
Nodes (41): assertBudgetNonNegative(), buildContextBudget(), BuildContextBudgetOptions, clampTokens(), ConfigIdentity, CONTEXT_COMPACTION_MAX_PASSES, CONTEXT_COMPACTION_STRATEGY_ORDER, CONTEXT_COMPACTION_TARGET_REDUCTION_PCT (+33 more)

### Community 14 - "media-generation.ts"
Cohesion: 0.07
Nodes (71): isValidStatus(), sendOpenAIError(), estimatePromptTokens(), extractPrompt(), formatGeneratedVideoContent(), handleMediaChatCompletion(), makeCompletionId(), ImageDataItem (+63 more)

### Community 15 - "core/errors.ts"
Cohesion: 0.14
Nodes (25): classifyError(), errorForStatus(), VALID_STATUSES, AuthError, ClientAbortedError, ContextLengthExceededError, ForbiddenError, InternalError (+17 more)

### Community 16 - "account-manager.ts"
Cohesion: 0.11
Nodes (28): hasActiveAccountLease(), getAllAccountHealth(), getPoolHealthAggregates(), buildSchedulerCandidates(), CooldownEntry, cooldowns, defaultCooldownDurationMs(), getAccountStateSnapshot() (+20 more)

### Community 17 - "maskEmail"
Cohesion: 0.28
Nodes (14): dotenv, listAccounts(), maskEmail(), addAccountFlow(), askQuestion(), clear(), removeAccountFlow(), rl (+6 more)

### Community 18 - "sync/index.ts"
Cohesion: 0.12
Nodes (34): restoreClaudeCode(), syncClaudeCode(), main(), parseArgs(), printHelp(), restoreCodex(), syncCodex(), updateTopLevelKey() (+26 more)

### Community 19 - "qwenUrl"
Cohesion: 0.14
Nodes (33): main(), main(), log(), main(), refHeaders(), hdrs(), main(), personalization (+25 more)

### Community 20 - "account-health.ts"
Cohesion: 0.13
Nodes (30): cleanupServerResources(), AccountFailureKind, cache, defaultRecord(), DELTA, dirty, envInt(), flushAccountHealth() (+22 more)

### Community 21 - "MemoryCache"
Cohesion: 0.06
Nodes (18): CacheEntry, CacheKey, compressAsync, decompressAsync, MemoryCache, classifyRamUsage(), getHeapUsageSnapshot(), getMemoryUsagePct() (+10 more)

### Community 22 - "migrations.ts"
Cohesion: 0.08
Nodes (25): better-sqlite3, backupDatabase(), bootPersistence(), BootResult, tablesPresent(), createGeneration(), MessageRepository, assertSchemaCurrent() (+17 more)

### Community 23 - "config.ts"
Cohesion: 0.08
Nodes (12): configuredParallelInit, configuredReserveReady, configuredTargetReady, configuredWarmupConcurrency, configWarnings, contextCap, effectiveReserveReady, effectiveWarmupConcurrency (+4 more)

### Community 24 - "anthropic/index.ts"
Cohesion: 0.10
Nodes (32): anthropicError(), app, constantTimeStringEqual(), generateRequestId(), verifyAnthropicApiKey(), AnthropicStreamState, generateMessageId(), generateToolId() (+24 more)

### Community 25 - "chat/index.ts"
Cohesion: 0.09
Nodes (34): abortLeaseBySessionLabel(), hasUnemittedSessionStream(), acquireChatLock(), createRequestRetryContext(), chatCompletions(), formatTimingHeader(), resolveChatMode(), shouldRetryInvalidInputOnSameAccount() (+26 more)

### Community 26 - "parser.ts"
Cohesion: 0.07
Nodes (39): EDIT_FILE_TOOLS, fullBody, READ_FILE_TOOLS, EDIT_FILE_TOOLS, GREP_TOOLS, WRITE_FILE_TOOLS, ActiveIncrementalToolCall, closeTagContentIsParseable() (+31 more)

### Community 27 - "browser-session-manager.ts"
Cohesion: 0.09
Nodes (18): FakeHandle, AccountCloser, BrowserBoundary, browserSessionManager, defaultPlaywrightBoundary(), defaultPlaywrightCloser(), OperationContext, WithOperationInput (+10 more)

### Community 28 - "model-registry.ts"
Cohesion: 0.10
Nodes (39): toAnthropicModel(), accountKey(), asRecord(), booleanValue(), cloneCapabilities(), defaultCapabilities, deriveCapabilities(), finitePositiveNumber() (+31 more)

### Community 29 - "captcha-solver.ts"
Cohesion: 0.08
Nodes (42): patchright, gotoBestEffort(), lastFailedRecoveryAt, recoverBaxiaCaptcha(), solveChallengeOnPage(), BAXIA_CONTENT_SELECTOR, BAXIA_DIALOG_SELECTOR, BAXIA_DOCUMENT_SELECTORS (+34 more)

### Community 30 - "tui.test.ts"
Cohesion: 0.20
Nodes (19): formatImageCard(), formatMarkdown(), formatMarkdownInline(), formatReasoning(), MarkdownOptions, wrapAnsiLine(), maskAccountIdentifier(), ANSI (+11 more)

### Community 31 - "session-repository.ts"
Cohesion: 0.13
Nodes (13): assertMonotonicVersion(), Session, SessionUpstreamMapping, AdvanceResult, AdvanceVersionInput, CreateSessionInput, ensuredUpstreamColumns, ensureUpstreamColumns() (+5 more)

### Community 32 - "server.ts"
Cohesion: 0.04
Nodes (37): @hono/node-server, uuid, app, assertPortAvailable(), buildPortInUseMessage(), buildStartedServerInfo(), claimDataDirLock(), constantTimeStringEqual() (+29 more)

### Community 33 - "hono"
Cohesion: 0.14
Nodes (13): hono, Bucket, createRateLimiter(), check(), RateLimitCheck, RateLimiter, RateLimiterOptions, rateLimitMiddleware() (+5 more)

### Community 34 - "event-recorder.ts"
Cohesion: 0.12
Nodes (18): EVENT_NAMES_BY_ENTITY, isSensitiveAttributeKey(), runtimeEvent, RuntimeEventIdentity, RuntimeEventName, SENSITIVE_ATTRIBUTE_KEYS, GenerationCoordinatorDeps, Harness (+10 more)

### Community 35 - "QwenProxy"
Cohesion: 0.07
Nodes (29): Accounts & Session, Anthropic Compatible, Anthropic SDK / Claude Code CLI, API Endpoints, CLI Commands, Configuration, Credits, cURL (+21 more)

### Community 36 - "StreamingToolParser"
Cohesion: 0.13
Nodes (8): feedChunked(), feedChunked(), advanceMarkdownCodeState(), balanceClosingBrackets(), isJsonPayloadTruncated(), parseJsonishString(), StreamingToolParser, ParsedToolCall

### Community 37 - "session-keeper.ts"
Cohesion: 0.14
Nodes (18): subtlePageActivity(), closeIdlePlaywrightAccounts(), getActivePlaywrightAccountIds(), getIdlePlaywrightAccountIds(), isAccountServingStream(), keepAlivePlaywrightAccount(), keepAlivePlaywrightAccountInner(), touchAccountActivity() (+10 more)

### Community 38 - "retry-policy.ts"
Cohesion: 0.18
Nodes (28): computeQuotaCooldownMs(), ANTI_BOT_CODE_SET, ANTI_BOT_MESSAGE_MARKERS, classifyQuotaCooldown(), classifyRetryAction(), errCode(), errMessage(), isAccountInitializationError() (+20 more)

### Community 39 - "instance.ts"
Cohesion: 0.10
Nodes (28): getAccountConcurrencySnapshot(), clearAllHeadersReadyAccounts(), initAccountOwnership(), resetAccountOwnershipForTests(), setAccountOwnership(), registerReady(), OwnershipFence, acquireGenerationAccount() (+20 more)

### Community 40 - "stream-registry.ts"
Cohesion: 0.16
Nodes (15): createError(), activeStreams, getStream(), getStreamKeyBySessionAndResponse(), getStreamKeysBySessionId(), markStreamEmitted(), registerStream(), removeStream() (+7 more)

### Community 41 - "app.ts"
Cohesion: 0.16
Nodes (20): DEFAULT_FALLBACK_MODELS, fetchHealth(), fetchLiveModels(), fetchProxyStatus(), formatUptime(), ProxyStatusSnapshot, resetAccountCooldownById(), resetAllCooldowns() (+12 more)

### Community 43 - "generation-coordinator.ts"
Cohesion: 0.07
Nodes (34): TypedRuntimeError, canAcceptResult(), Generation, GenerationAttempt, GenerationTimeline, hasIrreversibleSideEffects(), isAttemptedAccount(), isTerminal() (+26 more)

### Community 44 - "StreamManager"
Cohesion: 0.09
Nodes (4): asError(), byteLength(), DrainWaiter, StreamManager

### Community 45 - "chat/context.ts"
Cohesion: 0.11
Nodes (25): ChatMode, getModelContextWindow(), assertPromptWithinLimits(), getPromptLimitStats(), getUtf8ByteLength(), isRequestPersonalizationWithinLimit(), PromptLimitOptions, PromptLimitStats (+17 more)

### Community 46 - "instructions.ts"
Cohesion: 0.27
Nodes (8): buildToolInstructions(), formatToolsRepresentation(), toolInstructionsCache, buildCompactToolManifest(), formatParameterSignature(), getToolFunction(), TOOL_CALL_CLOSE, TOOL_CALL_OPEN

### Community 47 - "StressDriver"
Cohesion: 0.13
Nodes (8): buildSpecs(), runMix(), asFence(), hashSeed(), makeBaseGeneration(), SeededPrng, StressDriver, shuffle()

### Community 49 - "robustParseJSON"
Cohesion: 0.43
Nodes (4): closeBraces(), fixMissingOpeningQuotes(), robustParseJSON(), sanitizeAndBalance()

### Community 50 - "account-pool-readiness.integration.test.ts"
Cohesion: 0.13
Nodes (21): clearAllAccountCooldowns(), getHeadersReadyAccountIds(), markAccountHeadersReady(), unmarkAccountHeadersReady(), addAccount(), removeAccount(), main(), getAccountOwnership() (+13 more)

### Community 51 - "context-meter.ts"
Cohesion: 0.17
Nodes (17): getModelContextWindowSource(), AssistantCompleteEvent, BuildContextMeterInput, buildContextMeterSnapshot(), ContextMeterOptions, enrichUsageWithContextMeter(), getReservedOutputTokens(), MeteredUsage (+9 more)

### Community 52 - "egress.ts"
Cohesion: 0.16
Nodes (16): dottedFromNumericHost(), EgressValidateOptions, expandIPv6(), fetchUserMedia(), FetchUserMediaOptions, getAllowHttpDefault(), getAllowlistDefault(), getMaxBytesDefault() (+8 more)

### Community 53 - "forge-import.test.ts"
Cohesion: 0.10
Nodes (29): DATA_DIR, ensureAccountInPriority(), getAccountsByPriority(), isPersistableAccount(), loadPriority(), markAccountFailed(), markAccountSuccessful(), PRIORITY_FILE (+21 more)

### Community 54 - "adapter.ts"
Cohesion: 0.12
Nodes (20): stripFastSuffix(), applyEffortToModel(), EFFORT_ALIASES, NormalizedEffort, normalizeReasoningEffort(), buildInProgressResponse(), ChatChoice, chatCompletionsToResponses() (+12 more)

### Community 55 - "responses/types.ts"
Cohesion: 0.13
Nodes (23): ChatResponse, closeCurrentFunctionCall(), closeCurrentReasoning(), closeCurrentText(), processChatChunk(), ResponsesStreamState, ResponsesBuiltinTool, ResponsesContentPart (+15 more)

### Community 56 - "warmup-stress.test.ts"
Cohesion: 0.09
Nodes (20): Barrier, SYSTEM_FENCE, scheduler, retry, accountIds, controller, counters, HANGING_ACCOUNTS (+12 more)

### Community 57 - "qwen-chat-pool.ts"
Cohesion: 0.19
Nodes (23): isAuthMockEnabled(), buildCapturedQwenHeaders(), acquireNewQwenChatSession(), buildChatNewBody(), chatPoolKey(), createQwenChatSession(), fetchUnusedChats(), inFlightWarmChats (+15 more)

### Community 58 - "stickyMap.ts"
Cohesion: 0.09
Nodes (24): getPreferredModelsAccountId(), isAccountBusy(), isAccountTemporarilyBusy(), getAccountCooldownInfo(), isAccountHeadersReady(), getNextFreeAccountForParallel(), hasFreeAlternateAccount(), accountLoad() (+16 more)

### Community 59 - "upload.ts"
Cohesion: 0.17
Nodes (18): ali-oss, DEFAULT_FILE_TYPE_INFO, detectFileType(), downloadRemoteMedia(), FILE_TYPE_MAP, FileTypeInfo, getExtensionFromMime(), getFileExtension() (+10 more)

### Community 60 - "ServerProcess"
Cohesion: 0.16
Nodes (4): ServerProcess, ServerProcessEvent, ServerProcessEvents, ServerProcessState

### Community 61 - "toolcall-tags.ts"
Cohesion: 0.23
Nodes (13): findPartialToolOpenIndexOutsideMarkdownCode(), closeTagFor(), findToolOpen(), getCloseNames(), getOpenNames(), matchesAt(), matchToolCloseAt(), openTagName() (+5 more)

### Community 62 - "tiered.ts"
Cohesion: 0.08
Nodes (30): AcquireParams, MediaChatParams, assembleCompressedContext(), bm25RankIndices(), buildFailoverPrompt(), charsOf(), CompressedContext, ContextInput (+22 more)

### Community 63 - "logger.ts"
Cohesion: 0.05
Nodes (30): envLevel, isDebugEnabled(), isPassthroughObject(), LEVEL_RANK, LogEntry, LogFormat, logger, LogLevel (+22 more)

### Community 64 - "chat/validation.ts"
Cohesion: 0.20
Nodes (18): isToolcallDebugEnabled(), mapClientModelToQwen(), mapKnownModelAlias(), ReasoningMode, stripThinkingSuffix(), effortToReasoningMode(), buildPromptFromMessages(), buildResponseFormatInstruction() (+10 more)

### Community 65 - "generation-coordinator.test.ts"
Cohesion: 0.05
Nodes (28): AccountLease, AccountStatus, AttemptState, LeaseOwnershipSnapshot, LifecycleTransition, TERMINAL_ATTEMPT_STATES, TERMINAL_GENERATION_STATES, WarmupState (+20 more)

### Community 66 - "message-repository.ts"
Cohesion: 0.10
Nodes (20): Branch, Message, MessageRole, Tenant, TenantLimits, Turn, TurnStatus, ToolCall (+12 more)

### Community 68 - "fingerprint.ts"
Cohesion: 0.13
Nodes (18): clearFingerprintCache(), DEVICE_MEMORIES, FingerprintProfile, getFingerprintProfile(), getLanguageProfiles(), HARDWARE_CONCURRENCIES, LANGUAGE_PROFILES, mulberry32() (+10 more)

### Community 69 - "scripts"
Cohesion: 0.10
Nodes (21): scripts, benchmark:proxy, clean, clean:all, config:check, import:accounts, login, purge (+13 more)

### Community 70 - "paths.ts"
Cohesion: 0.27
Nodes (15): ensureDataDirs(), getAccountPriorityPath(), getDataDir(), getDbDir(), getDbPath(), getEncryptionKeyPath(), getEnvFilePath(), getOsGlobalDataDir() (+7 more)

### Community 71 - "account.ts"
Cohesion: 0.06
Nodes (52): isAccountSlotHeldByOtherSession(), markLeaseCompletion(), noteRequestPathNotHotExecution(), AccountStateFlags, authErrorAccounts, brokenAccounts, clearAccountAuthError(), clearAccountSessionExpired() (+44 more)

### Community 72 - "browser-process-cleanup.ts"
Cohesion: 0.20
Nodes (19): BrowserProcessRecord, ensureBrowserProcessHygiene(), installBrowserProcessExitCleanup(), isBrowserProcessName(), isOrphanReapSuppressed(), isPidAlive(), killBrowserProcessesForProfile(), killBrowserProcessTree() (+11 more)

### Community 73 - "responses/index.ts"
Cohesion: 0.21
Nodes (15): finalizeResponse(), responsesOutputToChatMessages(), app, start(), cache, deleteStoredResponse(), ensureTable(), getResponseHistory() (+7 more)

### Community 74 - "syncQwenRequestPersonalization"
Cohesion: 0.22
Nodes (14): getSettings(), label(), main(), post(), SAFE_SETTINGS_PATCH, sha(), isTokenExpiringSoon(), buildQwenSettingsUpdatePayload() (+6 more)

### Community 75 - "parser-truncated-tool-call.test.ts"
Cohesion: 0.25
Nodes (4): collect(), declaredTools, multiCallTools, truncatedWrite

### Community 76 - "FakeOwnership"
Cohesion: 0.10
Nodes (3): FakeAccount, FakeOwnership, makePool()

### Community 77 - "package.json"
Cohesion: 0.11
Nodes (18): author, bin, qpx, bugs, url, description, files, homepage (+10 more)

### Community 78 - "storage-view.ts"
Cohesion: 0.30
Nodes (9): cleanPlaywrightBrowsers(), formatBytes(), getDirStats(), walk(), main(), cleanupOrphanProfiles(), pruneAllPlaywrightProfiles(), prunePlaywrightProfileCaches() (+1 more)

### Community 79 - "responses/validation.ts"
Cohesion: 0.12
Nodes (16): zod, ResponsesRequest, BuiltInToolSchema, ContentPartSchema, FunctionCallInputSchema, FunctionCallOutputInputSchema, FunctionToolSchema, InputMessageSchema (+8 more)

### Community 80 - "context-stress.test.ts"
Cohesion: 0.09
Nodes (21): PrepareContextResult, buildContent(), buildMessages(), buildSchema(), capabilities, CASES, ContentKind, ContextCase (+13 more)

### Community 81 - "compilerOptions"
Cohesion: 0.12
Nodes (15): compilerOptions, allowImportingTsExtensions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit (+7 more)

### Community 82 - "config-check.mjs"
Cohesion: 0.13
Nodes (13): apiKey, checkInt(), DEFAULTS, envPath, errors, fileVars, get(), host (+5 more)

### Community 83 - "Mutex"
Cohesion: 0.31
Nodes (3): Mutex, getAccountMutex(), registerPlaywrightAccountForTests()

### Community 84 - "maintenance-scheduler.ts"
Cohesion: 0.15
Nodes (11): DEFAULT_PRIORITY, HIGH_PRIORITY, MaintenanceJob, MaintenanceJobKind, MaintenanceJobStatus, MaintenanceSchedulerOptions, MaintenanceSchedulerStats, sleep() (+3 more)

### Community 85 - "driver.ts"
Cohesion: 0.04
Nodes (35): ConstructRuntimeDeps, SYSTEM_FENCE, ReleaseOutcome, FakeStream, QwenRuntime, CloseReason, createStream(), createStreamRegistry() (+27 more)

### Community 87 - "metrics-emitter.ts"
Cohesion: 0.19
Nodes (12): ACCOUNT_STATE_METRICS, assertBoundedDimensions(), isAllowedDimension(), METRIC_DEFINITION, MetricDefinition, MetricKind, MetricName, filterKeys() (+4 more)

### Community 88 - "health.ts"
Cohesion: 0.11
Nodes (14): recordAccountTtfb(), AccountHealth, BURST_RETRY_AFTER_MS, CONSUME_FIRST_FAR_MS, CONSUME_FIRST_IMMINENT_MS, HEALTH_TTFB_WINDOW, HEALTH_WINDOW_ATTEMPTS, LATENCY_BAD_P99_MS (+6 more)

### Community 89 - "ChatView"
Cohesion: 0.27
Nodes (3): streamChatCompletions(), ChatView, classifyModel()

### Community 90 - "qwenproxy.js"
Cohesion: 0.15
Nodes (10): browserCommands, child, __dirname, firstArg, packageJsonPath, packageRoot, rawArgs, require (+2 more)

### Community 91 - "qwen-thread-state.ts"
Cohesion: 0.10
Nodes (17): createQwenStream(), cleanupStaleSessions(), clearAllSessionsForAccount(), flushLogicalThreadState(), getLogicalThreadState(), invalidateLogicalThreadParent(), LogicalThreadEntry, scheduleLogicalThreadFlush() (+9 more)

### Community 92 - "CONFIG.md — every runtime env var (Phase 3.3)"
Cohesion: 0.14
Nodes (13): Accounts & secrets (read outside schema), Browser / Playwright, Concurrency & leases, CONFIG.md — every runtime env var (Phase 3.3), Egress SSRF (2), Inbound caps & context, Observability / cache / watchdog, Pool / readiness (3) (+5 more)

### Community 95 - "initPlaywrightForAccount"
Cohesion: 0.15
Nodes (32): getAccountProfilePath(), acquireAccountMutex(), acquireContextAdmission(), autoInstallPlaywrightChromium(), buildChromiumLaunchArgs(), cancelAccountBrowserWork(), cleanupPlaywrightAccountState(), closePlaywrightContextBestEffort() (+24 more)

### Community 96 - ".tryRecoverToolCall"
Cohesion: 0.20
Nodes (9): coerceParameterValue(), decodeXmlEntities(), extractToolName(), getToolDefinitionName(), getToolDefinitionProperties(), inferToolNameFromParameters(), normalizeToolNameForMatch(), parseRecoverableXmlToolCall() (+1 more)

### Community 97 - "dependencies"
Cohesion: 0.20
Nodes (10): dependencies, ali-oss, better-sqlite3, dotenv, hono, @hono/node-server, patchright, tsx (+2 more)

### Community 98 - "update-cli.ts"
Cohesion: 0.33
Nodes (8): detectPackageManager(), __dirname, getUpdateArgs(), isNewerVersion(), packageJsonPath, PackageManager, packageRoot, runUpdateCommand()

### Community 100 - "broken-recovery.test.ts"
Cohesion: 0.34
Nodes (12): BROKEN_INIT_FAIL_THRESHOLD, getAccountHealth(), getBrokenRecoveryAgeMs(), hasPermanentInitEvidence(), isAccountBrokenByHealth(), resetInitFailureEscalation(), clearAccountBroken(), isAccountFlaggedBroken() (+4 more)

### Community 101 - "getDatabase"
Cohesion: 0.10
Nodes (43): clearTemporaryBusy(), resetAccountConcurrencyForTests(), resetAccountHealthForTests(), clearAccountCooldown(), markAccountRateLimited(), resetAccountManagerForTests(), invalidatePriorityCache(), resetAccountStateForTests() (+35 more)

### Community 102 - "chat-cleanup.ts"
Cohesion: 0.40
Nodes (8): getAccountCredentials(), run(), deleteChatsForAccount(), deleteChatsForAccountId(), deleteChatsForConfiguredAccounts(), DeleteChatsResult, ensurePlaywrightSession(), deleteAllQwenChats()

### Community 104 - "account-scheduler.ts"
Cohesion: 0.33
Nodes (8): AccountHealthRecord, getRecent429Rate(), getTtfbFactor(), pickSchedulerCandidate(), rankByScore(), SchedulerCandidate, SchedulerOptions, QwenAccount

### Community 105 - "OPERATIONS.md — QwenProxy runbook (Phase 3.3)"
Cohesion: 0.20
Nodes (9): 1. Startup requirements, 2. Liveness vs readiness, 3. Logging, 4. Dirs / volumes, 5. Graceful shutdown, 6. Failure modes, 7. Log redaction, 8. TUI (+1 more)

### Community 106 - "latency-optimizations.test.ts"
Cohesion: 0.39
Nodes (7): getP50Ttfb(), computePoolAvgTtfb(), HedgeDecision, lastHedgePerSession, recordHedgeExecution(), resetHedgingForTests(), shouldHedgeRequest()

### Community 107 - "auth-playwright.ts"
Cohesion: 0.25
Nodes (8): ensurePlaywrightInitialized(), getBasicHeaders(), HeaderResult, isRunningUnderNodeTest(), isPlaywrightInitialized(), asModelRecord(), fetchQwenModels(), formatPublicQwenModel()

### Community 108 - "models.ts"
Cohesion: 0.16
Nodes (17): FailFastTimeoutError, ModelsUnavailableError, withDeadline(), app, augmentWithMediaModels(), baseModelId(), buildStaticCatalog(), canAttemptLiveCatalog() (+9 more)

### Community 109 - "performanceMetrics"
Cohesion: 0.33
Nodes (3): performanceMetrics, RequestMetrics, RollingStats

### Community 110 - "context-compressor.ts"
Cohesion: 0.12
Nodes (17): bm25Rank(), buildSummary(), Chunk, chunkExchanges(), compressContextForFailover(), CompressResult, ParsedExchange, parseExchanges() (+9 more)

### Community 111 - "devDependencies"
Cohesion: 0.50
Nodes (4): devDependencies, @types/better-sqlite3, @types/node, typescript

### Community 113 - "ali-oss.d.ts"
Cohesion: 0.29
Nodes (4): ali-oss, OSS, OSSOptions, PutOptions

### Community 114 - "SECURITY.md — threat model & controls (Phase 3.3)"
Cohesion: 0.22
Nodes (8): 1. Threat model, 2. Auth, 3. SSRF egress (`src/utils/egress.ts`), 4. Inbound caps, 5. Secrets handling, 6. Log redaction, 7. Residual risks, SECURITY.md — threat model & controls (Phase 3.3)

### Community 117 - "request-path-no-cold-init.test.ts"
Cohesion: 0.29
Nodes (5): mockState, originalArgv, restoreArgv(), restoreEnv(), warmedHeaders

### Community 118 - "cli.test.ts"
Cohesion: 0.50
Nodes (3): binPath, __dirname, packageRoot

### Community 120 - "repository"
Cohesion: 0.67
Nodes (3): repository, type, url

### Community 122 - "TuiApp"
Cohesion: 0.27
Nodes (4): TuiApp, main(), parseInitialTab(), LogsView

### Community 123 - "shared-browser.test.ts"
Cohesion: 0.39
Nodes (7): getRestorableCookies(), getStorageStatePath(), isPlaywrightAlreadyClosedError(), isTokenCookieJwtExpired(), loadStorageState(), pickStorageStatePath(), saveStorageState()

### Community 124 - "readiness-controller.ts"
Cohesion: 0.20
Nodes (6): AccountWarmState, ReadinessDeps, ReadinessOptions, TickReport, WarmupRecord, fastBackoff

### Community 136 - "parser.test.ts"
Cohesion: 0.50
Nodes (3): EDIT_FILE_TOOLS, FLAT_TOOLS, TOOLS

## Knowledge Gaps
- **731 isolated node(s):** `require`, `__dirname`, `packageRoot`, `packageJsonPath`, `rawArgs` (+726 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 1132 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **22 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Config` connect `getDatabase` to `account-concurrency.ts`, `retry-coordinator.ts`, `qwen.ts`, `chromium-args.test.ts`, `playwright.ts`, `chat/streaming.ts`, `media-generation.ts`, `core/errors.ts`, `account-manager.ts`, `maskEmail`, `sync/index.ts`, `qwenUrl`, `MemoryCache`, `config.ts`, `anthropic/index.ts`, `chat/index.ts`, `captcha-solver.ts`, `server.ts`, `hono`, `session-keeper.ts`, `retry-policy.ts`, `app.ts`, `chat/context.ts`, `context-meter.ts`, `forge-import.test.ts`, `qwen-chat-pool.ts`, `upload.ts`, `chat/validation.ts`, `account.ts`, `responses/index.ts`, `driver.ts`, `qwen-thread-state.ts`, `latency-optimizations.test.ts`, `models.ts`, `context-compressor.ts`?**
  _High betweenness centrality (0.069) - this node is a cross-community bridge._
- **Why does `getDatabase()` connect `getDatabase` to `generation-repository.ts`, `accounts.ts`, `qwen.ts`, `chat/streaming.ts`, `account-manager.ts`, `account-health.ts`, `migrations.ts`, `chat/index.ts`, `session-repository.ts`, `stream-registry.ts`, `account-pool-readiness.integration.test.ts`, `forge-import.test.ts`, `stickyMap.ts`, `logger.ts`, `message-repository.ts`, `responses/index.ts`, `syncQwenRequestPersonalization`, `qwen-thread-state.ts`, `broken-recovery.test.ts`, `context-compressor.ts`?**
  _High betweenness centrality (0.033) - this node is a cross-community bridge._
- **Why does `logger` connect `logger.ts` to `account-concurrency.ts`, `qwen.ts`, `playwright.ts`, `chat/streaming.ts`, `media-generation.ts`, `core/errors.ts`, `chat/index.ts`, `parser.ts`, `server.ts`, `retry-policy.ts`, `robustParseJSON`, `context-meter.ts`, `qwen-chat-pool.ts`, `stickyMap.ts`, `chat/validation.ts`, `account.ts`, `responses/index.ts`, `metrics-emitter.ts`, `health.ts`, `qwen-thread-state.ts`, `getDatabase`, `latency-optimizations.test.ts`, `context-compressor.ts`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **What connects `require`, `__dirname`, `packageRoot` to the rest of the system?**
  _731 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `account-concurrency.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.14408602150537633 - nodes in this community are weakly interconnected._
- **Should `retry-coordinator.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.08076923076923077 - nodes in this community are weakly interconnected._
- **Should `generation-repository.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05555555555555555 - nodes in this community are weakly interconnected._