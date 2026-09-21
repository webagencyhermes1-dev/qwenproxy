# Graph Report - QwenProxy  (2026-09-18)

## Corpus Check
- 334 files · ~352,063 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 8 file(s) not represented in the graph (top: (none) 4, .bat 3, .example 1)

## Summary
- 3185 nodes · 9185 edges · 129 communities (108 shown, 20 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 107 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `ec4f35ce`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- resource-manager.ts
- maintenance-scheduler.ts
- generation-coordinator.ts
- GenerationRepository
- driver.ts
- getDatabase
- qwen.ts
- message-repository.ts
- playwright.ts
- account.ts
- proxy-baseline.ts
- IAccountOwnership
- chat/streaming.ts
- context-service.ts
- media-generation.ts
- core/errors.ts
- account-manager.ts
- server.ts
- sync/index.ts
- qwenUrl
- account-health.ts
- chat/index.ts
- migrations.ts
- MaintenanceScheduler
- anthropic/index.ts
- chat/context.ts
- parser.ts
- browser-session-manager.ts
- model-registry.ts
- captcha-solver.ts
- chat-view.ts
- session-repository.ts
- tool-calls-endpoint.test.ts
- media.ts
- event-recorder.ts
- QwenProxy
- isToolcallDebugEnabled
- session-keeper.ts
- retry-policy.ts
- tool-integrity-stress.test.ts
- StressDriver
- proxy-client.ts
- .getInstance
- .feed
- StreamManager
- utils/types.ts
- context-stress.test.ts
- MemoryCache
- FakeOwnership
- robustParseJSON
- initPlaywrightForAccount
- warmup-stress.test.ts
- request-path.test.ts
- forge-import.test.ts
- adapter.ts
- responses/types.ts
- Message
- qwen-chat-pool.ts
- stickyMap.ts
- upload.ts
- metrics-emitter.ts
- auth-playwright.ts
- readiness-guard.ts
- logger.ts
- chat/validation.ts
- retry-coordinator.ts
- context/summary.ts
- maintenance-clients.test.ts
- fingerprint.ts
- scripts
- tiered.ts
- isAuthMockEnabled
- health.ts
- responses/index.ts
- construct.ts
- parser-truncated-tool-call.test.ts
- Config
- package.json
- storage-view.ts
- responses/validation.ts
- toolcall-tags.ts
- compilerOptions
- session-service.ts
- context-meter.ts
- instructions.ts
- SeededPrng
- OperationRegistry
- generation-coordinator.test.ts
- Mutex
- ChatView
- qwenproxy.js
- lease-repository.ts
- shared-browser.test.ts
- ServerManager
- StreamingToolParser
- getBasicHeaders
- .tryRecoverToolCall
- dependencies
- update-cli.ts
- AccountsView
- vectorStore.ts
- newJobId
- syncQwenRequestPersonalization
- PerformanceView
- SyncView
- ids.ts
- models.ts
- performanceMetrics
- context-compressor.ts
- agenticStress.test.ts
- TuiView
- ali-oss.d.ts
- logger
- devDependencies
- cli.test.ts
- docker-entrypoint.sh
- repository
- install.sh
- start.sh
- update.sh
- STRESS_RESULT
- STRESS_RESULT
- STRESS_RESULT
- STRESS_RESULT
- STRESS_RESULT
- mutex.ts
- logical-thread-batch.test.ts
- parser.test.ts

## God Nodes (most connected - your core abstractions)
1. `getDatabase()` - 99 edges
2. `Config` - 62 edges
3. `tryCreateStreamWithRetry()` - 58 edges
4. `qwenUrl()` - 58 edges
5. `StreamingToolParser` - 54 edges
6. `loadAccounts()` - 53 edges
7. `processStreamingResponse()` - 50 edges
8. `chatCompletions()` - 42 edges
9. `invalidateAccountsCache()` - 41 edges
10. `StreamManager` - 39 edges

## Surprising Connections (you probably didn't know these)
- `FakeAccount` --references--> `AccountStatus`  [EXTRACTED]
  src/runtime/readiness/maintenance-clients.test.ts → src/domain/types.ts
- `FakeAccount` --references--> `AccountStatus`  [EXTRACTED]
  src/runtime/readiness/readiness-controller.test.ts → src/domain/types.ts
- `Harness` --references--> `ManagedStream`  [EXTRACTED]
  src/runtime/stream/stream-manager.test.ts → src/runtime/stream/stream-manager.ts
- `sendOpenAIError()` --calls--> `classifyError()`  [EXTRACTED]
  src/api/error-helpers.ts → src/api/error-classifier.ts
- `handleChatCompletionsError()` --calls--> `classifyError()`  [EXTRACTED]
  src/routes/chat/streaming.ts → src/api/error-classifier.ts

## Import Cycles
- 2-file cycle: `src/services/qwen-chat-pool.ts -> src/services/qwen.ts -> src/services/qwen-chat-pool.ts`

## Communities (129 total, 20 thin omitted)

### Community 0 - "resource-manager.ts"
Cohesion: 0.06
Nodes (34): ErrorCode, AccountLease, AccountStatus, AccountResourceManager, InternalAccountRecord, now(), SYSTEM_FENCE, registerReady() (+26 more)

### Community 1 - "maintenance-scheduler.ts"
Cohesion: 0.15
Nodes (11): DEFAULT_PRIORITY, HIGH_PRIORITY, MaintenanceJob, MaintenanceJobKind, MaintenanceJobStatus, MaintenanceSchedulerOptions, MaintenanceSchedulerStats, sleep() (+3 more)

### Community 2 - "generation-coordinator.ts"
Cohesion: 0.06
Nodes (46): TypedRuntimeError, canAcceptResult(), Generation, GenerationAttempt, GenerationTimeline, hasIrreversibleSideEffects(), isAttemptedAccount(), isTerminal() (+38 more)

### Community 3 - "GenerationRepository"
Cohesion: 0.13
Nodes (7): emptySideEffects(), ensureExtraColumns(), GenerationRepository, parseIdArray(), parseSideEffects(), rowToGeneration(), createGeneration()

### Community 4 - "driver.ts"
Cohesion: 0.07
Nodes (36): ReleaseOutcome, buildSpecs(), counters, FAIL_MODES, Mix, MIXES, recorder, SCENARIO_NAME (+28 more)

### Community 5 - "getDatabase"
Cohesion: 0.09
Nodes (40): getCachedAccounts(), invalidateAccountsCache(), parseEnvAccounts(), setAccountDisabled(), syncEnvAccounts(), updateAccountCooldown(), DATA_DIR, decrypt() (+32 more)

### Community 6 - "qwen.ts"
Cohesion: 0.04
Nodes (63): onBrowserContextCreated(), accountStreamMutexes, AccountStreamSlots, acquireAccountStreamLock(), activePersonalizationByAccount, addIdleTimeoutToStream(), browserStreamBindingContexts, browserStreamBindingPages (+55 more)

### Community 7 - "message-repository.ts"
Cohesion: 0.09
Nodes (21): Branch, Message, MessageRole, Tenant, TenantLimits, Turn, TurnStatus, ToolCall (+13 more)

### Community 8 - "playwright.ts"
Cohesion: 0.04
Nodes (53): setWafContextResetListener(), accountContexts, AccountHeaderCache, accountMutexes, accountPages, assertAntiBotHeaders(), BrowserEngineConfig, BrowserType (+45 more)

### Community 9 - "account.ts"
Cohesion: 0.07
Nodes (73): abortLeaseByLabel(), AccountLease, AccountSlot, acquireAccountLease(), AcquireAccountLeaseOptions, acquireFromOwnershipAuthority(), ActiveLeaseInfo, cleanupEntry() (+65 more)

### Community 10 - "proxy-baseline.ts"
Cohesion: 0.08
Nodes (53): AccountBenchmarkContext, BENCH_RUN_ID, BenchmarkConfig, benchmarkNonStream(), BenchmarkReport, benchmarkStream(), buildAccountBenchmarkContext(), buildChatBody() (+45 more)

### Community 11 - "IAccountOwnership"
Cohesion: 0.06
Nodes (13): ReadinessControllerClients, StartRuntimeServicesOptions, IAccountOwnership, AccountWarmState, ReadinessController, ReadinessDeps, ReadinessOptions, FakeAccount (+5 more)

### Community 12 - "chat/streaming.ts"
Cohesion: 0.08
Nodes (49): activeStreams, getStream(), markStreamEmitted(), registerStream(), removeStream(), updateStreamSessionId(), updateStreamTargetResponseId(), CreateStreamSuccess (+41 more)

### Community 13 - "context-service.ts"
Cohesion: 0.07
Nodes (41): assertBudgetNonNegative(), buildContextBudget(), BuildContextBudgetOptions, clampTokens(), ConfigIdentity, CONTEXT_COMPACTION_MAX_PASSES, CONTEXT_COMPACTION_STRATEGY_ORDER, CONTEXT_COMPACTION_TARGET_REDUCTION_PCT (+33 more)

### Community 14 - "media-generation.ts"
Cohesion: 0.10
Nodes (45): startBaxiaCaptchaWatcher(), assertNotRateLimited(), BROWSER_FORBIDDEN_HEADERS, BrowserCompletionResponse, buildCompletionsPayload(), buildHeadersFromCaptured(), CHAT_MEDIA_MODEL, createMediaChatSession() (+37 more)

### Community 15 - "core/errors.ts"
Cohesion: 0.14
Nodes (24): classifyError(), errorForStatus(), VALID_STATUSES, AuthError, ClientAbortedError, ForbiddenError, InternalError, NotFoundError (+16 more)

### Community 16 - "account-manager.ts"
Cohesion: 0.16
Nodes (16): anyUsableAccountHeadersReady(), CooldownEntry, cooldowns, defaultCooldownDurationMs(), getAccountStateSnapshot(), getPoolStats(), headersReadyAccounts, isAccountHeadersReady() (+8 more)

### Community 17 - "server.ts"
Cohesion: 0.04
Nodes (42): app, assertPortAvailable(), buildPortInUseMessage(), buildStartedServerInfo(), cleanupServerResources(), formatAccountId(), getErrorMessage(), handleSignal() (+34 more)

### Community 18 - "sync/index.ts"
Cohesion: 0.08
Nodes (57): dotenv, listAccounts(), ensureDataDirs(), getAccountPriorityPath(), getAccountProfilePath(), getDataDir(), getDbDir(), getDbPath() (+49 more)

### Community 19 - "qwenUrl"
Cohesion: 0.15
Nodes (30): main(), main(), log(), main(), refHeaders(), hdrs(), main(), personalization (+22 more)

### Community 20 - "account-health.ts"
Cohesion: 0.12
Nodes (38): AccountFailureKind, AccountHealthRecord, BROKEN_INIT_FAIL_THRESHOLD, cache, defaultRecord(), DELTA, dirty, flushAccountHealth() (+30 more)

### Community 21 - "chat/index.ts"
Cohesion: 0.14
Nodes (22): abortLeaseBySessionLabel(), hasUnemittedSessionStream(), ChatMode, acquireChatLock(), AcquireParams, BuildContextParams, FinalContext, chatCompletions() (+14 more)

### Community 22 - "migrations.ts"
Cohesion: 0.15
Nodes (15): better-sqlite3, bootPersistence(), BootResult, tablesPresent(), assertSchemaCurrent(), getSchemaVersion(), MIGRATIONS, MigrationStep (+7 more)

### Community 24 - "anthropic/index.ts"
Cohesion: 0.10
Nodes (32): anthropicError(), app, constantTimeStringEqual(), generateRequestId(), verifyAnthropicApiKey(), AnthropicStreamState, generateMessageId(), generateToolId() (+24 more)

### Community 25 - "chat/context.ts"
Cohesion: 0.14
Nodes (19): ContextLengthExceededError, assertPromptWithinLimits(), getPromptLimitStats(), getUtf8ByteLength(), isRequestPersonalizationWithinLimit(), PromptLimitOptions, PromptLimitStats, truncatePromptToIntelligentLimit() (+11 more)

### Community 26 - "parser.ts"
Cohesion: 0.15
Nodes (20): ActiveIncrementalToolCall, balanceClosingBrackets(), closeTagContentIsParseable(), FlatToolDefinition, IncrementalJsonToolSnapshot, inspectIncrementalJsonToolObject(), isJsonPrimitiveComplete(), parseToolArgumentsStrict() (+12 more)

### Community 27 - "browser-session-manager.ts"
Cohesion: 0.09
Nodes (16): FakeHandle, AccountCloser, BrowserBoundary, browserSessionManager, defaultPlaywrightBoundary(), defaultPlaywrightCloser(), OperationContext, WithOperationInput (+8 more)

### Community 28 - "model-registry.ts"
Cohesion: 0.09
Nodes (42): toAnthropicModel(), accountKey(), asRecord(), booleanValue(), cloneCapabilities(), defaultCapabilities, deriveCapabilities(), finitePositiveNumber() (+34 more)

### Community 29 - "captcha-solver.ts"
Cohesion: 0.08
Nodes (43): patchright, gotoBestEffort(), lastFailedRecoveryAt, recoverBaxiaCaptcha(), solveChallengeOnPage(), BAXIA_CONTENT_SELECTOR, BAXIA_DIALOG_SELECTOR, BAXIA_DOCUMENT_SELECTORS (+35 more)

### Community 30 - "chat-view.ts"
Cohesion: 0.29
Nodes (13): formatImageCard(), formatMarkdown(), formatMarkdownInline(), formatReasoning(), MarkdownOptions, wrapAnsiLine(), drawBox(), pad() (+5 more)

### Community 31 - "session-repository.ts"
Cohesion: 0.11
Nodes (14): assertMonotonicVersion(), Session, SessionUpstreamMapping, AdvanceResult, AdvanceVersionInput, CreateSessionInput, ensuredUpstreamColumns, ensureUpstreamColumns() (+6 more)

### Community 33 - "media.ts"
Cohesion: 0.09
Nodes (38): hono, createError(), isValidStatus(), sendOpenAIError(), constantTimeStringEqual(), extractProvidedApiKeys(), verifyApiKey(), getStreamKeyBySessionAndResponse() (+30 more)

### Community 34 - "event-recorder.ts"
Cohesion: 0.12
Nodes (18): EVENT_NAMES_BY_ENTITY, isSensitiveAttributeKey(), runtimeEvent, RuntimeEventIdentity, RuntimeEventName, SENSITIVE_ATTRIBUTE_KEYS, GenerationCoordinatorDeps, Harness (+10 more)

### Community 35 - "QwenProxy"
Cohesion: 0.07
Nodes (29): Accounts & Session, Anthropic Compatible, Anthropic SDK / Claude Code CLI, API Endpoints, CLI Commands, Configuration, Credits, cURL (+21 more)

### Community 36 - "isToolcallDebugEnabled"
Cohesion: 0.19
Nodes (4): isToolcallDebugEnabled(), findMatchingClosingBrace(), ParserResult, ParsedToolCall

### Community 37 - "session-keeper.ts"
Cohesion: 0.14
Nodes (21): hasActiveAccountLease(), closeIdlePlaywrightAccounts(), closePlaywrightForAccountLocked(), evictIdlePlaywrightContextsToLimit(), getActivePlaywrightAccountIds(), getIdlePlaywrightAccountIds(), isAccountServingStream(), keepAlivePlaywrightAccount() (+13 more)

### Community 38 - "retry-policy.ts"
Cohesion: 0.13
Nodes (30): computeQuotaCooldownMs(), ANTI_BOT_CODE_SET, ANTI_BOT_MESSAGE_MARKERS, classifyQuotaCooldown(), classifyRetryAction(), errCode(), errMessage(), isAccountInitializationError() (+22 more)

### Community 39 - "tool-integrity-stress.test.ts"
Cohesion: 0.10
Nodes (19): assertToolRoundStructurallyValid(), canonicalizeToolArguments(), isToolRoundComplete(), sortKeys(), ToolCallEvent, toolCallFingerprint(), ToolCallStatus, ToolDefinition (+11 more)

### Community 40 - "StressDriver"
Cohesion: 0.19
Nodes (5): runMix(), asFence(), FakeSink, makeBaseGeneration(), StressDriver

### Community 41 - "proxy-client.ts"
Cohesion: 0.20
Nodes (19): cachedAccounts, DEFAULT_FALLBACK_MODELS, fetchProxyStatus(), formatUptime(), maskAccountIdentifier(), resetAccountCooldownById(), KeyHandler, MouseInfo (+11 more)

### Community 42 - ".getInstance"
Cohesion: 0.18
Nodes (4): TuiApp, main(), parseInitialTab(), Screen

### Community 43 - ".feed"
Cohesion: 0.19
Nodes (12): feedChunked(), advanceMarkdownCodeState(), findCandidateStarts(), findCloseTagOccurrences(), findNextToolOpenTagOutsideMarkdownCode(), findPartialMissingOpenToolCallIndex(), findRecoverableMissingOpenToolCall(), findToolEndOutsideJsonString() (+4 more)

### Community 44 - "StreamManager"
Cohesion: 0.08
Nodes (5): asError(), byteLength(), DrainWaiter, StreamManager, StreamManagerError

### Community 45 - "utils/types.ts"
Cohesion: 0.13
Nodes (11): deriveSessionId(), extractTextContent(), buildRepeatedToolCallReminder(), canonicalize(), toolCallKey(), ChatCompletionChunk, Choice, ChoiceDelta (+3 more)

### Community 46 - "context-stress.test.ts"
Cohesion: 0.10
Nodes (19): PrepareContextResult, buildContent(), buildMessages(), buildSchema(), capabilities, CASES, ContentKind, ContextCase (+11 more)

### Community 47 - "MemoryCache"
Cohesion: 0.05
Nodes (18): setCacheForTesting(), CacheEntry, CacheKey, compressAsync, decompressAsync, MemoryCache, classifyRamUsage(), getHeapUsageSnapshot() (+10 more)

### Community 49 - "robustParseJSON"
Cohesion: 0.18
Nodes (8): getToolDefinitionProperties(), isJsonPayloadTruncated(), parseJsonishString(), scanJsonStructureIncomplete(), closeBraces(), fixMissingOpeningQuotes(), robustParseJSON(), sanitizeAndBalance()

### Community 50 - "initPlaywrightForAccount"
Cohesion: 0.19
Nodes (19): clearFingerprintCache(), updateChromeMajor(), acquireAccountMutex(), autoInstallPlaywrightChromium(), buildChromiumLaunchArgs(), cleanupPlaywrightAccountState(), getOrLaunchSharedBrowser(), getStealthScript() (+11 more)

### Community 51 - "warmup-stress.test.ts"
Cohesion: 0.09
Nodes (20): Barrier, scheduler, retry, accountIds, controller, counters, HANGING_ACCOUNTS, hangLatches (+12 more)

### Community 52 - "request-path.test.ts"
Cohesion: 0.16
Nodes (12): initAccountOwnership(), resetAccountOwnershipForTests(), registerReady(), acquireGenerationAccount(), AcquireGenerationAccountRequest, AcquireGenerationAccountResult, bindGateway(), buildCandidates() (+4 more)

### Community 53 - "forge-import.test.ts"
Cohesion: 0.11
Nodes (28): DATA_DIR, ensureAccountInPriority(), isPersistableAccount(), loadPriority(), markAccountFailed(), markAccountSuccessful(), PRIORITY_FILE, PriorityData (+20 more)

### Community 54 - "adapter.ts"
Cohesion: 0.11
Nodes (19): stripFastSuffix(), applyEffortToModel(), EFFORT_ALIASES, NormalizedEffort, buildInProgressResponse(), ChatChoice, chatCompletionsToResponses(), ChatHistoryMessage (+11 more)

### Community 55 - "responses/types.ts"
Cohesion: 0.13
Nodes (23): ChatResponse, closeCurrentFunctionCall(), closeCurrentReasoning(), closeCurrentText(), processChatChunk(), ResponsesStreamState, ResponsesBuiltinTool, ResponsesContentPart (+15 more)

### Community 56 - "Message"
Cohesion: 0.14
Nodes (17): accountLoad(), clearSelectionClaimsForTests(), gcClaims(), pendingClaims, selectAccountForNewSession(), SelectionContext, CompressedContext, extractFirstUserText() (+9 more)

### Community 57 - "qwen-chat-pool.ts"
Cohesion: 0.20
Nodes (20): buildCapturedQwenHeaders(), acquireNewQwenChatSession(), buildChatNewBody(), chatPoolKey(), createQwenChatSession(), fetchUnusedChats(), inFlightWarmChats, isQwenChatPoolEnabled() (+12 more)

### Community 58 - "stickyMap.ts"
Cohesion: 0.12
Nodes (11): ensureTable(), isExpired(), isTestEnv(), isValidStickyKey(), RedisClient, redisKey(), resetStickyMapForTests(), StickyMap (+3 more)

### Community 59 - "upload.ts"
Cohesion: 0.17
Nodes (19): DEFAULT_FILE_TYPE_INFO, detectFileType(), downloadRemoteMedia(), FILE_TYPE_MAP, FileTypeInfo, getExtensionFromMime(), getFileExtension(), getFilenameFromUrl() (+11 more)

### Community 60 - "metrics-emitter.ts"
Cohesion: 0.19
Nodes (12): ACCOUNT_STATE_METRICS, assertBoundedDimensions(), isAllowedDimension(), METRIC_DEFINITION, MetricDefinition, MetricKind, MetricName, filterKeys() (+4 more)

### Community 61 - "auth-playwright.ts"
Cohesion: 0.23
Nodes (13): getAccountCredentials(), run(), ensurePlaywrightInitialized(), HeaderResult, isRunningUnderNodeTest(), isTokenExpiringSoon(), deleteChatsForAccount(), deleteChatsForAccountId() (+5 more)

### Community 62 - "readiness-guard.ts"
Cohesion: 0.09
Nodes (44): clearAccountCooldown(), clearAllAccountCooldowns(), getHeadersReadyAccountIds(), markAccountHeadersReady(), unmarkAccountHeadersReady(), addAccount(), removeAccount(), coalescedPoolCheck() (+36 more)

### Community 63 - "logger.ts"
Cohesion: 0.11
Nodes (12): envLevel, isDebugEnabled(), isPassthroughObject(), LEVEL_RANK, LogEntry, LogLevel, redactLogMessage(), redactLogValue() (+4 more)

### Community 64 - "chat/validation.ts"
Cohesion: 0.19
Nodes (19): mapClientModelToQwen(), mapKnownModelAlias(), ReasoningMode, stripThinkingSuffix(), effortToReasoningMode(), normalizeReasoningEffort(), MediaChatParams, buildPromptFromMessages() (+11 more)

### Community 65 - "retry-coordinator.ts"
Cohesion: 0.11
Nodes (20): CONTEXT_BUDGET_ERRORS, HTTP_STATUS_BY_ERROR_CODE, isContextBudgetError(), isTerminalGenerationError(), LEGACY_TO_ERROR_CODE, TERMINAL_GENERATION_ERRORS, ACCOUNT_LEVEL_CODES, CHAT_SETTLE_CODES (+12 more)

### Community 66 - "context/summary.ts"
Cohesion: 0.13
Nodes (12): prepareCompressedFailoverPrompt(), toDomainFailoverMessages(), ensureTable(), extractiveChunk(), getRollingSummary(), messageText(), TODO: use smallest pool model / local model for abstractive summary., resetRollingSummaryForTests() (+4 more)

### Community 67 - "maintenance-clients.test.ts"
Cohesion: 0.16
Nodes (13): READINESS_CONTROLLER_FLAG, registerReadinessControllerClients(), resetReadinessControllerClientsForTests(), warmupDedupeKey(), resetRuntimeServicesForTests(), startRuntimeServices(), stopRuntimeServices(), WarmupJobAdapter (+5 more)

### Community 68 - "fingerprint.ts"
Cohesion: 0.14
Nodes (16): DEVICE_MEMORIES, FingerprintProfile, getFingerprintProfile(), getLanguageProfiles(), HARDWARE_CONCURRENCIES, LANGUAGE_PROFILES, mulberry32(), NOT_A_BRAND_VARIANTS (+8 more)

### Community 69 - "scripts"
Cohesion: 0.11
Nodes (19): scripts, benchmark:proxy, clean, clean:all, import:accounts, login, purge, reset (+11 more)

### Community 70 - "tiered.ts"
Cohesion: 0.19
Nodes (15): assembleCompressedContext(), bm25RankIndices(), buildFailoverPrompt(), charsOf(), ContextInput, FailoverPromptInput, FailoverPromptResult, groupExchanges() (+7 more)

### Community 71 - "isAuthMockEnabled"
Cohesion: 0.27
Nodes (12): isAuthMockEnabled(), asModelRecord(), fetchQwenModels(), formatPublicQwenModel(), cleanupStaleSessions(), flushLogicalThreadState(), invalidateLogicalThreadParent(), LogicalThreadEntry (+4 more)

### Community 72 - "health.ts"
Cohesion: 0.12
Nodes (15): AccountHealth, BURST_RETRY_AFTER_MS, CONSUME_FIRST_FAR_MS, CONSUME_FIRST_IMMINENT_MS, HEALTH_TTFB_WINDOW, HEALTH_WINDOW_ATTEMPTS, HealthTracker, LATENCY_BAD_P99_MS (+7 more)

### Community 73 - "responses/index.ts"
Cohesion: 0.21
Nodes (15): finalizeResponse(), responsesOutputToChatMessages(), app, start(), cache, deleteStoredResponse(), ensureTable(), getResponseHistory() (+7 more)

### Community 74 - "construct.ts"
Cohesion: 0.05
Nodes (29): RuntimeServices, constructRuntime(), ConstructRuntimeDeps, recoverNonterminalGenerations(), SYSTEM_FENCE, warmAccount(), RetryCoordinator, QwenRuntime (+21 more)

### Community 75 - "parser-truncated-tool-call.test.ts"
Cohesion: 0.40
Nodes (4): declaredTools, feedChunked(), multiCallTools, truncatedWrite

### Community 76 - "Config"
Cohesion: 0.10
Nodes (32): clearTemporaryBusy(), resetAccountConcurrencyForTests(), resetAccountHealthForTests(), markAccountRateLimited(), resetAccountManagerForTests(), invalidatePriorityCache(), resetAccountStateForTests(), Config (+24 more)

### Community 77 - "package.json"
Cohesion: 0.09
Nodes (22): author, bin, qpx, bugs, url, description, engines, node (+14 more)

### Community 78 - "storage-view.ts"
Cohesion: 0.29
Nodes (9): cleanPlaywrightBrowsers(), formatBytes(), getDirStats(), walk(), main(), cleanupOrphanProfiles(), pruneAllPlaywrightProfiles(), resetAllCooldowns() (+1 more)

### Community 79 - "responses/validation.ts"
Cohesion: 0.12
Nodes (16): zod, ResponsesRequest, BuiltInToolSchema, ContentPartSchema, FunctionCallInputSchema, FunctionCallOutputInputSchema, FunctionToolSchema, InputMessageSchema (+8 more)

### Community 80 - "toolcall-tags.ts"
Cohesion: 0.21
Nodes (14): findPartialToolOpenIndexOutsideMarkdownCode(), scanCloseTagOutsideStringsAndFences(), closeTagFor(), findToolOpen(), getCloseNames(), getOpenNames(), matchesAt(), matchToolCloseAt() (+6 more)

### Community 81 - "compilerOptions"
Cohesion: 0.12
Nodes (15): compilerOptions, allowImportingTsExtensions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit (+7 more)

### Community 82 - "session-service.ts"
Cohesion: 0.17
Nodes (11): BeginGenerationInput, BeginGenerationResult, CommitGenerationInput, CommitGenerationResult, DEFAULT_TENANT_ID, FailGenerationInput, IDEMPOTENCY_KEY_HEADER, ResolveSessionInput (+3 more)

### Community 83 - "context-meter.ts"
Cohesion: 0.26
Nodes (9): BuildContextMeterInput, buildContextMeterSnapshot(), ContextMeterOptions, getReservedOutputTokens(), roundPercent(), PersonalizationEstimationInfo, enabledOptions, estimatePart() (+1 more)

### Community 84 - "instructions.ts"
Cohesion: 0.31
Nodes (7): buildToolInstructions(), formatToolsRepresentation(), toolInstructionsCache, buildCompactToolManifest(), formatParameterSignature(), getToolFunction(), TOOL_CALL_CLOSE

### Community 85 - "SeededPrng"
Cohesion: 0.29
Nodes (3): hashSeed(), SeededPrng, shuffle()

### Community 87 - "generation-coordinator.test.ts"
Cohesion: 0.08
Nodes (10): GenerationStreamSource, FakeStream, FakeStreams, RETRY_TEST_CONFIG, setup(), CloseReason, CreateStreamInput, DeadlineCascade (+2 more)

### Community 88 - "Mutex"
Cohesion: 0.21
Nodes (6): Mutex, PERSONALIZATION_LOCK_ACQUIRE_TIMEOUT_MS, PERSONALIZATION_SYNC_DEADLINE_MS, getAccountMutex(), registerPlaywrightAccountForTests(), unregisterPlaywrightAccountForTests()

### Community 89 - "ChatView"
Cohesion: 0.22
Nodes (5): fetchLiveModels(), streamChatCompletions(), getClipboardText(), ChatView, classifyModel()

### Community 90 - "qwenproxy.js"
Cohesion: 0.15
Nodes (10): browserCommands, child, __dirname, firstArg, packageJsonPath, packageRoot, rawArgs, require (+2 more)

### Community 91 - "lease-repository.ts"
Cohesion: 0.14
Nodes (12): AccountLeaseRow, ensuredOutcomeColumn, ensureOutcomeColumn(), EXTRA_COLUMNS, LeaseRepository, LeaseRow, LeaseState, rowToLease() (+4 more)

### Community 92 - "shared-browser.test.ts"
Cohesion: 0.48
Nodes (5): getRestorableCookies(), getStorageStatePath(), isTokenCookieJwtExpired(), loadStorageState(), pickStorageStatePath()

### Community 94 - "StreamingToolParser"
Cohesion: 0.08
Nodes (10): collect(), EDIT_FILE_TOOLS, fullBody, READ_FILE_TOOLS, EDIT_FILE_TOOLS, GREP_TOOLS, WRITE_FILE_TOOLS, getToolDefinitionName() (+2 more)

### Community 95 - "getBasicHeaders"
Cohesion: 0.17
Nodes (23): fetchJsonInBrowser(), captureQwenHeaders(), captureQwenHeadersInner(), closePlaywrightContextBestEffort(), getBasicHeaders(), getCookies(), getCookieSnapshot(), getErrorMessage() (+15 more)

### Community 96 - ".tryRecoverToolCall"
Cohesion: 0.52
Nodes (6): coerceParameterValue(), decodeXmlEntities(), extractToolName(), inferToolNameFromParameters(), parseRecoverableXmlToolCall(), parseXmlParameterToolCall()

### Community 97 - "dependencies"
Cohesion: 0.20
Nodes (10): dependencies, ali-oss, better-sqlite3, dotenv, hono, @hono/node-server, patchright, tsx (+2 more)

### Community 98 - "update-cli.ts"
Cohesion: 0.33
Nodes (8): detectPackageManager(), __dirname, getUpdateArgs(), isNewerVersion(), packageJsonPath, PackageManager, packageRoot, runUpdateCommand()

### Community 100 - "vectorStore.ts"
Cohesion: 0.20
Nodes (7): bm25Score(), ensureTable(), Entry, getVectorStore(), resetVectorStoreForTests(), VectorHit, VectorStore

### Community 102 - "syncQwenRequestPersonalization"
Cohesion: 0.24
Nodes (13): getSettings(), label(), main(), post(), SAFE_SETTINGS_PATCH, sha(), buildQwenSettingsUpdatePayload(), getPersonalizationHashFromDb() (+5 more)

### Community 106 - "ids.ts"
Cohesion: 0.26
Nodes (12): newAttemptId(), newBranchId(), newEventId(), newGenerationId(), newLeaseId(), newMessageId(), newOperationId(), newOwnerToken() (+4 more)

### Community 108 - "models.ts"
Cohesion: 0.27
Nodes (8): app, baseModelId(), expandModelVariants(), getPreferredModelsAccountId(), loadModelsWithVariants(), PublicModel, listMediaGenerationModels(), isPlaywrightInitialized()

### Community 109 - "performanceMetrics"
Cohesion: 0.33
Nodes (3): performanceMetrics, RequestMetrics, RollingStats

### Community 110 - "context-compressor.ts"
Cohesion: 0.24
Nodes (10): bm25Rank(), buildSummary(), Chunk, chunkExchanges(), compressContextForFailover(), CompressResult, ParsedExchange, parseExchanges() (+2 more)

### Community 111 - "agenticStress.test.ts"
Cohesion: 0.24
Nodes (7): @hono/node-server, getFreePort(), isPortAvailable(), localTools, toolDefinitions, getFreePort(), isPortAvailable()

### Community 112 - "TuiView"
Cohesion: 0.13
Nodes (5): KeyEvent, setClipboardText(), TuiView, LogsView, StatusView

### Community 113 - "ali-oss.d.ts"
Cohesion: 0.29
Nodes (4): ali-oss, OSS, OSSOptions, PutOptions

### Community 115 - "logger"
Cohesion: 0.35
Nodes (3): logger, capture(), Session

### Community 116 - "devDependencies"
Cohesion: 0.50
Nodes (4): devDependencies, @types/better-sqlite3, @types/node, typescript

### Community 118 - "cli.test.ts"
Cohesion: 0.50
Nodes (3): binPath, __dirname, packageRoot

### Community 122 - "repository"
Cohesion: 0.67
Nodes (3): repository, type, url

### Community 136 - "parser.test.ts"
Cohesion: 0.50
Nodes (3): EDIT_FILE_TOOLS, FLAT_TOOLS, TOOLS

## Knowledge Gaps
- **630 isolated node(s):** `require`, `__dirname`, `packageRoot`, `packageJsonPath`, `rawArgs` (+625 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 982 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **20 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Config` connect `Config` to `getDatabase`, `qwen.ts`, `playwright.ts`, `account.ts`, `chat/streaming.ts`, `media-generation.ts`, `core/errors.ts`, `account-manager.ts`, `server.ts`, `sync/index.ts`, `qwenUrl`, `account-health.ts`, `chat/index.ts`, `anthropic/index.ts`, `chat/context.ts`, `captcha-solver.ts`, `media.ts`, `session-keeper.ts`, `retry-policy.ts`, `proxy-client.ts`, `MemoryCache`, `forge-import.test.ts`, `qwen-chat-pool.ts`, `upload.ts`, `auth-playwright.ts`, `readiness-guard.ts`, `chat/validation.ts`, `retry-coordinator.ts`, `responses/index.ts`, `construct.ts`, `context-meter.ts`, `context-compressor.ts`?**
  _High betweenness centrality (0.064) - this node is a cross-community bridge._
- **Why does `getDatabase()` connect `getDatabase` to `generation-coordinator.ts`, `qwen.ts`, `message-repository.ts`, `account.ts`, `chat/streaming.ts`, `account-health.ts`, `migrations.ts`, `session-repository.ts`, `forge-import.test.ts`, `stickyMap.ts`, `readiness-guard.ts`, `context/summary.ts`, `isAuthMockEnabled`, `responses/index.ts`, `Config`, `session-service.ts`, `lease-repository.ts`, `vectorStore.ts`, `syncQwenRequestPersonalization`?**
  _High betweenness centrality (0.045) - this node is a cross-community bridge._
- **Why does `ReadinessController` connect `IAccountOwnership` to `warmup-stress.test.ts`, `construct.ts`, `maintenance-clients.test.ts`, `readiness-guard.ts`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._
- **What connects `require`, `__dirname`, `packageRoot` to the rest of the system?**
  _630 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `resource-manager.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.061754385964912284 - nodes in this community are weakly interconnected._
- **Should `generation-coordinator.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06316590563165905 - nodes in this community are weakly interconnected._
- **Should `GenerationRepository` be split into smaller, more focused modules?**
  _Cohesion score 0.13333333333333333 - nodes in this community are weakly interconnected._