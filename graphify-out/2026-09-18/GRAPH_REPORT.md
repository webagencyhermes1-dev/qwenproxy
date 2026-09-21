# Graph Report - QwenProxy  (2026-09-18)

## Corpus Check
- 332 files · ~349,663 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 8 file(s) not represented in the graph (top: (none) 4, .bat 3, .example 1)

## Summary
- 3169 nodes · 9088 edges · 138 communities (111 shown, 26 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 107 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `ec4f35ce`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- generation-coordinator.test.ts
- MemoryCache
- generation-coordinator.ts
- GenerationRepository
- driver.ts
- accounts.ts
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
- QwenAccount
- chat/index.ts
- migrations.ts
- MaintenanceScheduler
- anthropic/index.ts
- prompt-limits.ts
- parser.ts
- browser-session-manager.ts
- model-registry.ts
- captcha-solver.ts
- markdown.ts
- session-repository.ts
- tool-calls-endpoint.test.ts
- videos.ts
- event-recorder.ts
- QwenProxy
- StreamingToolParser
- session-keeper.ts
- retry-policy.ts
- tool-integrity.test.ts
- StressDriver
- app.ts
- .getInstance
- streaming-thinking-summary.test.ts
- StreamManager
- utils/types.ts
- context-stress.test.ts
- metrics
- FakeOwnership
- robustParseJSON
- initPlaywrightForAccount
- AccountResourceManager
- construct.ts
- forge-import.test.ts
- adapter.ts
- responses/types.ts
- selection.ts
- qwen-chat-pool.ts
- stickyMap.ts
- upload.ts
- metrics-emitter.ts
- chat-cleanup.ts
- readiness-guard.ts
- logger.ts
- chat/validation.ts
- retry-coordinator.ts
- context/summary.ts
- maintenance-clients.test.ts
- fingerprint.ts
- scripts
- tiered.ts
- account-state.ts
- health.ts
- responses/index.ts
- stream-manager.ts
- parser-truncated-tool-call.test.ts
- getDatabase
- package.json
- storage-view.ts
- responses/validation.ts
- toolcall-tags.ts
- compilerOptions
- paths.ts
- context-meter.ts
- domain/types.ts
- HealthTracker
- OperationRegistry
- ManagedStream
- Mutex
- ChatView
- qwenproxy.js
- lease-repository.ts
- maskEmail
- ServerManager
- t3-close-tag-escape.test.ts
- getBasicHeaders
- .tryRecoverToolCall
- dependencies
- update-cli.ts
- proxy-client.ts
- vectorStore.ts
- chat/context.ts
- auth-playwright.ts
- PerformanceView
- SyncView
- model-aware-context-budget.test.ts
- ids.ts
- config.ts
- models.ts
- performanceMetrics
- context-compressor.ts
- agenticStress.test.ts
- TuiView
- ali-oss.d.ts
- logger
- devDependencies
- app
- cli.test.ts
- stop.ts
- memory-cache.ts
- docker-entrypoint.sh
- repository
- bin
- removePlaywrightProfile
- engines
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
- tool-recovery-t1t2.test.ts

## God Nodes (most connected - your core abstractions)
1. `getDatabase()` - 95 edges
2. `Config` - 61 edges
3. `qwenUrl()` - 58 edges
4. `tryCreateStreamWithRetry()` - 57 edges
5. `StreamingToolParser` - 54 edges
6. `loadAccounts()` - 52 edges
7. `processStreamingResponse()` - 50 edges
8. `chatCompletions()` - 42 edges
9. `StreamManager` - 39 edges
10. `logger` - 38 edges

## Surprising Connections (you probably didn't know these)
- `snapshotAccounts()` --calls--> `getDatabase()`  [EXTRACTED]
  src/tests/accounts-security.test.ts → src/core/database.ts
- `snapshotAccounts()` --calls--> `getDatabase()`  [EXTRACTED]
  src/tests/server-lifecycle.test.ts → src/core/database.ts
- `registerQwen38Max()` --calls--> `syncModelMetadata()`  [EXTRACTED]
  src/tests/model-3.8-max-semantic.test.ts → src/core/model-registry.ts
- `CompleteOutcome` --references--> `ErrorCode`  [EXTRACTED]
  src/runtime/generation/generation-coordinator.ts → src/domain/errors.ts
- `FakeAccount` --references--> `AccountStatus`  [EXTRACTED]
  src/runtime/readiness/maintenance-clients.test.ts → src/domain/types.ts

## Import Cycles
- 2-file cycle: `src/services/qwen-chat-pool.ts -> src/services/qwen.ts -> src/services/qwen-chat-pool.ts`

## Communities (138 total, 26 thin omitted)

### Community 0 - "generation-coordinator.test.ts"
Cohesion: 0.10
Nodes (21): ErrorCode, AccountLease, InternalAccountRecord, SYSTEM_FENCE, AcquireFailureCode, AcquireLeaseRequest, AcquireLeaseResult, AcquireRejection (+13 more)

### Community 2 - "generation-coordinator.ts"
Cohesion: 0.09
Nodes (33): TypedRuntimeError, canAcceptResult(), Generation, GenerationAttempt, isTerminal(), remainingDeadline(), GenerationState, isTerminalGenerationState() (+25 more)

### Community 3 - "GenerationRepository"
Cohesion: 0.15
Nodes (11): recoverNonterminalGenerations(), emptySideEffects(), ensureExtraColumns(), GenerationRepository, parseIdArray(), parseSideEffects(), rowToGeneration(), EPOCH_MS_NOW() (+3 more)

### Community 4 - "driver.ts"
Cohesion: 0.04
Nodes (60): MaintenanceJob, counters, FAIL_MODES, Mix, MIXES, recorder, SCENARIO_NAME, Barrier (+52 more)

### Community 5 - "accounts.ts"
Cohesion: 0.09
Nodes (29): getCachedAccounts(), isAccountDisabledRecord(), parseEnvAccounts(), syncEnvAccounts(), DATA_DIR, decrypt(), encrypt(), getOrCreateKey() (+21 more)

### Community 6 - "qwen.ts"
Cohesion: 0.05
Nodes (59): onBrowserContextCreated(), accountStreamMutexes, AccountStreamSlots, acquireAccountStreamLock(), activePersonalizationByAccount, addIdleTimeoutToStream(), browserStreamBindingContexts, browserStreamBindingPages (+51 more)

### Community 7 - "message-repository.ts"
Cohesion: 0.09
Nodes (21): Branch, Message, MessageRole, Tenant, TenantLimits, Turn, TurnStatus, ToolCall (+13 more)

### Community 8 - "playwright.ts"
Cohesion: 0.04
Nodes (63): setWafContextResetListener(), defaultPlaywrightBoundary(), subtlePageActivity(), accountContexts, AccountHeaderCache, accountMutexes, accountPages, assertAntiBotHeaders() (+55 more)

### Community 9 - "account.ts"
Cohesion: 0.06
Nodes (61): abortLeaseByLabel(), AccountLease, AccountSlot, acquireAccountLease(), AcquireAccountLeaseOptions, acquireFromOwnershipAuthority(), ActiveLeaseInfo, cleanupEntry() (+53 more)

### Community 10 - "proxy-baseline.ts"
Cohesion: 0.08
Nodes (53): AccountBenchmarkContext, BENCH_RUN_ID, BenchmarkConfig, benchmarkNonStream(), BenchmarkReport, benchmarkStream(), buildAccountBenchmarkContext(), buildChatBody() (+45 more)

### Community 11 - "IAccountOwnership"
Cohesion: 0.12
Nodes (4): ReadinessControllerClients, RuntimeServices, IAccountOwnership, ReadinessController

### Community 12 - "chat/streaming.ts"
Cohesion: 0.10
Nodes (46): markStreamEmitted(), registerStream(), updateStreamSessionId(), updateStreamTargetResponseId(), isWafChallenge(), ParsedQwenErrorPayload, parseQwenErrorPayload(), applyUpstreamUsage() (+38 more)

### Community 13 - "context-service.ts"
Cohesion: 0.07
Nodes (41): assertBudgetNonNegative(), buildContextBudget(), BuildContextBudgetOptions, clampTokens(), ConfigIdentity, CONTEXT_COMPACTION_MAX_PASSES, CONTEXT_COMPACTION_STRATEGY_ORDER, CONTEXT_COMPACTION_TARGET_REDUCTION_PCT (+33 more)

### Community 14 - "media-generation.ts"
Cohesion: 0.09
Nodes (53): estimatePromptTokens(), extractPrompt(), formatGeneratedVideoContent(), handleMediaChatCompletion(), makeCompletionId(), MediaChatParams, assertNotRateLimited(), BROWSER_FORBIDDEN_HEADERS (+45 more)

### Community 15 - "core/errors.ts"
Cohesion: 0.14
Nodes (24): classifyError(), errorForStatus(), VALID_STATUSES, AuthError, ClientAbortedError, ForbiddenError, InternalError, NotFoundError (+16 more)

### Community 16 - "account-manager.ts"
Cohesion: 0.13
Nodes (33): getPreferredModelsAccountId(), hasActiveAccountLease(), anyUsableAccountHeadersReady(), buildSchedulerCandidates(), clearAllAccountCooldowns(), computeQuotaCooldownMs(), CooldownEntry, cooldowns (+25 more)

### Community 17 - "server.ts"
Cohesion: 0.09
Nodes (46): assertPortAvailable(), buildPortInUseMessage(), buildStartedServerInfo(), cleanupServerResources(), constantTimeStringEqual(), extractProvidedApiKeys(), formatAccountId(), getErrorMessage() (+38 more)

### Community 18 - "sync/index.ts"
Cohesion: 0.15
Nodes (33): restoreClaudeCode(), syncClaudeCode(), main(), parseArgs(), printHelp(), restoreCodex(), syncCodex(), updateTopLevelKey() (+25 more)

### Community 19 - "qwenUrl"
Cohesion: 0.13
Nodes (27): uuid, log(), main(), refHeaders(), hdrs(), main(), personalization, TOOLS (+19 more)

### Community 20 - "QwenAccount"
Cohesion: 0.31
Nodes (10): AccountHealthRecord, getRecent429Rate(), getTtfbFactor(), pickFromCandidates(), pickSchedulerCandidate(), rankSchedulerCandidates(), SchedulerCandidate, SchedulerOptions (+2 more)

### Community 21 - "chat/index.ts"
Cohesion: 0.09
Nodes (35): abortLeaseBySessionLabel(), hasUnemittedSessionStream(), acquireChatLock(), CreateStreamSuccess, isQuarantinedForAccount(), markQuarantinedForAccount(), quarantineChallengedAccountOnce(), StreamCreationResult (+27 more)

### Community 22 - "migrations.ts"
Cohesion: 0.20
Nodes (14): bootPersistence(), BootResult, tablesPresent(), assertSchemaCurrent(), getSchemaVersion(), MIGRATIONS, MigrationStep, MissingMigrationStepError (+6 more)

### Community 23 - "MaintenanceScheduler"
Cohesion: 0.09
Nodes (14): newJobId(), DEFAULT_PRIORITY, HIGH_PRIORITY, MaintenanceJobKind, MaintenanceJobStatus, MaintenanceScheduler, MaintenanceSchedulerOptions, MaintenanceSchedulerStats (+6 more)

### Community 24 - "anthropic/index.ts"
Cohesion: 0.10
Nodes (32): anthropicError(), app, constantTimeStringEqual(), generateRequestId(), verifyAnthropicApiKey(), AnthropicStreamState, generateMessageId(), generateToolId() (+24 more)

### Community 25 - "prompt-limits.ts"
Cohesion: 0.22
Nodes (12): ContextLengthExceededError, getModelContextWindow(), assertPromptWithinLimits(), getPromptLimitStats(), getUtf8ByteLength(), isRequestPersonalizationWithinLimit(), PromptLimitOptions, PromptLimitStats (+4 more)

### Community 26 - "parser.ts"
Cohesion: 0.09
Nodes (35): READ_FILE_TOOLS, EDIT_FILE_TOOLS, ActiveIncrementalToolCall, advanceMarkdownCodeState(), balanceClosingBrackets(), closeTagContentIsParseable(), findCandidateStarts(), findCloseTagOccurrences() (+27 more)

### Community 27 - "browser-session-manager.ts"
Cohesion: 0.10
Nodes (14): FakeHandle, AccountCloser, BrowserBoundary, browserSessionManager, defaultPlaywrightCloser(), OperationContext, WithOperationInput, browserOwnershipEnabled() (+6 more)

### Community 28 - "model-registry.ts"
Cohesion: 0.14
Nodes (27): accountKey(), asRecord(), booleanValue(), cloneCapabilities(), defaultCapabilities, deriveCapabilities(), finitePositiveNumber(), firstPositiveNumber() (+19 more)

### Community 29 - "captcha-solver.ts"
Cohesion: 0.09
Nodes (41): patchright, gotoBestEffort(), lastFailedRecoveryAt, recoverBaxiaCaptcha(), solveChallengeOnPage(), BAXIA_CONTENT_SELECTOR, BAXIA_DIALOG_SELECTOR, BAXIA_DOCUMENT_SELECTORS (+33 more)

### Community 30 - "markdown.ts"
Cohesion: 0.48
Nodes (6): formatImageCard(), formatMarkdown(), formatMarkdownInline(), formatReasoning(), MarkdownOptions, wrapAnsiLine()

### Community 31 - "session-repository.ts"
Cohesion: 0.10
Nodes (15): better-sqlite3, assertMonotonicVersion(), Session, SessionUpstreamMapping, AdvanceResult, AdvanceVersionInput, CreateSessionInput, ensuredUpstreamColumns (+7 more)

### Community 33 - "videos.ts"
Cohesion: 0.17
Nodes (19): hono, isValidStatus(), sendOpenAIError(), ImageDataItem, imagesGenerations(), ImagesGenerationsRequest, urlToBase64(), validationError() (+11 more)

### Community 34 - "event-recorder.ts"
Cohesion: 0.12
Nodes (18): EVENT_NAMES_BY_ENTITY, isSensitiveAttributeKey(), runtimeEvent, RuntimeEventIdentity, RuntimeEventName, SENSITIVE_ATTRIBUTE_KEYS, GenerationCoordinatorDeps, Harness (+10 more)

### Community 35 - "QwenProxy"
Cohesion: 0.07
Nodes (29): Accounts & Session, Anthropic Compatible, Anthropic SDK / Claude Code CLI, API Endpoints, CLI Commands, Configuration, Credits, cURL (+21 more)

### Community 36 - "StreamingToolParser"
Cohesion: 0.13
Nodes (6): feedChunked(), isJsonPayloadTruncated(), parseJsonishString(), scanJsonStructureIncomplete(), StreamingToolParser, ParsedToolCall

### Community 37 - "session-keeper.ts"
Cohesion: 0.12
Nodes (21): humanDelay(), closeIdlePlaywrightAccounts(), evictIdlePlaywrightContextsToLimit(), getActivePlaywrightAccountIds(), getIdlePlaywrightAccountIds(), isAccountServingStream(), keepAlivePlaywrightAccount(), priorityOrderForEviction() (+13 more)

### Community 38 - "retry-policy.ts"
Cohesion: 0.14
Nodes (29): ANTI_BOT_CODE_SET, ANTI_BOT_MESSAGE_MARKERS, classifyQuotaCooldown(), classifyRetryAction(), errCode(), errMessage(), isAccountInitializationError(), isAntiBotChallengeText() (+21 more)

### Community 39 - "tool-integrity.test.ts"
Cohesion: 0.13
Nodes (15): assertToolRoundStructurallyValid(), canonicalizeToolArguments(), isToolRoundComplete(), sortKeys(), ToolCallEvent, toolCallFingerprint(), ToolCallStatus, ToolDefinition (+7 more)

### Community 40 - "StressDriver"
Cohesion: 0.12
Nodes (9): buildSpecs(), runMix(), asFence(), FakeSink, hashSeed(), makeBaseGeneration(), SeededPrng, StressDriver (+1 more)

### Community 41 - "app.ts"
Cohesion: 0.24
Nodes (22): formatUptime(), KeyEvent, KeyHandler, MouseInfo, ResizeHandler, ServerLifecycleState, ServerLogEntry, ANSI (+14 more)

### Community 42 - ".getInstance"
Cohesion: 0.13
Nodes (6): TuiApp, main(), parseInitialTab(), Screen, setClipboardText(), LogsView

### Community 44 - "StreamManager"
Cohesion: 0.08
Nodes (5): asError(), byteLength(), DrainWaiter, StreamManager, StreamManagerError

### Community 45 - "utils/types.ts"
Cohesion: 0.12
Nodes (14): CompressedContext, StickyKeyRequest, deriveSessionId(), extractTextContent(), buildRepeatedToolCallReminder(), canonicalize(), toolCallKey(), ChatCompletionChunk (+6 more)

### Community 46 - "context-stress.test.ts"
Cohesion: 0.15
Nodes (15): PrepareContextResult, buildContent(), buildMessages(), buildSchema(), capabilities, CASES, ContentKind, ContextCase (+7 more)

### Community 47 - "metrics"
Cohesion: 0.12
Nodes (12): classifyRamUsage(), getHeapUsageSnapshot(), getMemoryUsagePct(), getRssUsageSnapshot(), HeapUsageSnapshot, RssUsageSnapshot, MetricDefinition, MetricPoint (+4 more)

### Community 49 - "robustParseJSON"
Cohesion: 0.43
Nodes (4): closeBraces(), fixMissingOpeningQuotes(), robustParseJSON(), sanitizeAndBalance()

### Community 50 - "initPlaywrightForAccount"
Cohesion: 0.14
Nodes (21): getAccountProfilePath(), autoInstallPlaywrightChromium(), buildChromiumLaunchArgs(), cleanupPlaywrightAccountState(), closePlaywrightForAccountLocked(), getOrLaunchSharedBrowser(), getRestorableCookies(), getStealthScript() (+13 more)

### Community 51 - "AccountResourceManager"
Cohesion: 0.14
Nodes (11): AccountResourceManager, now(), registerReady(), ACCOUNT_TERMINAL_STATES, assertAccountTransition(), canTransitionAccount(), describeTransition(), exhaustiveCheck() (+3 more)

### Community 52 - "construct.ts"
Cohesion: 0.14
Nodes (15): initAccountOwnership(), resetAccountOwnershipForTests(), constructRuntime(), ConstructRuntimeDeps, SYSTEM_FENCE, warmAccount(), acquireGenerationAccount(), AcquireGenerationAccountRequest (+7 more)

### Community 53 - "forge-import.test.ts"
Cohesion: 0.11
Nodes (28): DATA_DIR, ensureAccountInPriority(), isPersistableAccount(), loadPriority(), markAccountFailed(), markAccountSuccessful(), PRIORITY_FILE, PriorityData (+20 more)

### Community 54 - "adapter.ts"
Cohesion: 0.12
Nodes (20): stripFastSuffix(), applyEffortToModel(), EFFORT_ALIASES, NormalizedEffort, normalizeReasoningEffort(), buildInProgressResponse(), ChatChoice, chatCompletionsToResponses() (+12 more)

### Community 55 - "responses/types.ts"
Cohesion: 0.13
Nodes (23): ChatResponse, closeCurrentFunctionCall(), closeCurrentReasoning(), closeCurrentText(), processChatChunk(), ResponsesStreamState, ResponsesBuiltinTool, ResponsesContentPart (+15 more)

### Community 56 - "selection.ts"
Cohesion: 0.16
Nodes (13): accountLoad(), clearSelectionClaimsForTests(), gcClaims(), pendingClaims, selectAccountForNewSession(), SelectionContext, extractFirstUserText(), generateStickyKey() (+5 more)

### Community 57 - "qwen-chat-pool.ts"
Cohesion: 0.20
Nodes (20): buildCapturedQwenHeaders(), acquireNewQwenChatSession(), buildChatNewBody(), chatPoolKey(), createQwenChatSession(), fetchUnusedChats(), inFlightWarmChats, isQwenChatPoolEnabled() (+12 more)

### Community 58 - "stickyMap.ts"
Cohesion: 0.11
Nodes (12): ensureTable(), isExpired(), isTestEnv(), isValidStickyKey(), RedisClient, redisKey(), resetStickyMapForTests(), StickyBinding (+4 more)

### Community 59 - "upload.ts"
Cohesion: 0.18
Nodes (18): DEFAULT_FILE_TYPE_INFO, detectFileType(), downloadRemoteMedia(), FILE_TYPE_MAP, FileTypeInfo, getExtensionFromMime(), getFileExtension(), getFilenameFromUrl() (+10 more)

### Community 60 - "metrics-emitter.ts"
Cohesion: 0.19
Nodes (12): ACCOUNT_STATE_METRICS, assertBoundedDimensions(), isAllowedDimension(), METRIC_DEFINITION, MetricDefinition, MetricKind, MetricName, filterKeys() (+4 more)

### Community 61 - "chat-cleanup.ts"
Cohesion: 0.36
Nodes (9): getAccountCredentials(), run(), deleteChatsForAccount(), deleteChatsForAccountId(), deleteChatsForConfiguredAccounts(), DeleteChatsResult, ensurePlaywrightSession(), isPlaywrightInitialized() (+1 more)

### Community 62 - "readiness-guard.ts"
Cohesion: 0.12
Nodes (31): getHeadersReadyAccountIds(), markAccountHeadersReady(), unmarkAccountHeadersReady(), addAccount(), removeAccount(), coalescedPoolCheck(), counters, ensurePoolReadiness() (+23 more)

### Community 63 - "logger.ts"
Cohesion: 0.11
Nodes (12): envLevel, isDebugEnabled(), isPassthroughObject(), LEVEL_RANK, LogEntry, LogLevel, redactLogMessage(), redactLogValue() (+4 more)

### Community 64 - "chat/validation.ts"
Cohesion: 0.13
Nodes (25): isToolcallDebugEnabled(), mapClientModelToQwen(), mapKnownModelAlias(), ReasoningMode, stripThinkingSuffix(), effortToReasoningMode(), buildPromptFromMessages(), buildResponseFormatInstruction() (+17 more)

### Community 65 - "retry-coordinator.ts"
Cohesion: 0.06
Nodes (32): CONTEXT_BUDGET_ERRORS, HTTP_STATUS_BY_ERROR_CODE, isContextBudgetError(), isTerminalGenerationError(), LEGACY_TO_ERROR_CODE, TERMINAL_GENERATION_ERRORS, GenerationTimeline, hasIrreversibleSideEffects() (+24 more)

### Community 66 - "context/summary.ts"
Cohesion: 0.16
Nodes (9): ensureTable(), extractiveChunk(), messageText(), TODO: use smallest pool model / local model for abstractive summary., resetRollingSummaryForTests(), RollingSummary, SUMMARY_CONTEXT_TRIGGER_CHARS, SUMMARY_EVERY_N_TURNS (+1 more)

### Community 67 - "maintenance-clients.test.ts"
Cohesion: 0.13
Nodes (17): READINESS_CONTROLLER_FLAG, registerReadinessControllerClients(), resetReadinessControllerClientsForTests(), warmupDedupeKey(), resetRuntimeServicesForTests(), startRuntimeServices(), StartRuntimeServicesOptions, stopRuntimeServices() (+9 more)

### Community 68 - "fingerprint.ts"
Cohesion: 0.13
Nodes (19): clearFingerprintCache(), DEVICE_MEMORIES, FingerprintProfile, getChromeMajor(), getFingerprintProfile(), getLanguageProfiles(), HARDWARE_CONCURRENCIES, LANGUAGE_PROFILES (+11 more)

### Community 69 - "scripts"
Cohesion: 0.11
Nodes (19): scripts, benchmark:proxy, clean, clean:all, import:accounts, login, purge, reset (+11 more)

### Community 70 - "tiered.ts"
Cohesion: 0.19
Nodes (16): AcquireParams, assembleCompressedContext(), bm25RankIndices(), buildFailoverPrompt(), charsOf(), ContextInput, FailoverPromptInput, FailoverPromptResult (+8 more)

### Community 71 - "account-state.ts"
Cohesion: 0.15
Nodes (12): AccountStateFlags, authErrorAccounts, brokenAccounts, clearAccountAuthError(), clearAccountBroken(), clearAccountSessionExpired(), deriveAccountState(), isAccountFlaggedAuthError() (+4 more)

### Community 72 - "health.ts"
Cohesion: 0.12
Nodes (13): AccountHealth, BURST_RETRY_AFTER_MS, CONSUME_FIRST_FAR_MS, CONSUME_FIRST_IMMINENT_MS, HEALTH_TTFB_WINDOW, HEALTH_WINDOW_ATTEMPTS, LATENCY_BAD_P99_MS, LATENCY_FLOOR (+5 more)

### Community 73 - "responses/index.ts"
Cohesion: 0.21
Nodes (15): finalizeResponse(), responsesOutputToChatMessages(), app, start(), cache, deleteStoredResponse(), ensureTable(), getResponseHistory() (+7 more)

### Community 74 - "stream-manager.ts"
Cohesion: 0.06
Nodes (25): QwenRuntime, CloseReason, createStream(), createStreamRegistry(), defaultStreamRegistry, encoder, getStream(), hasUnemittedStream() (+17 more)

### Community 75 - "parser-truncated-tool-call.test.ts"
Cohesion: 0.22
Nodes (5): collect(), declaredTools, feedChunked(), multiCallTools, truncatedWrite

### Community 76 - "getDatabase"
Cohesion: 0.11
Nodes (37): clearTemporaryBusy(), resetAccountConcurrencyForTests(), resetAccountHealthForTests(), clearAccountCooldown(), resetAccountManagerForTests(), invalidatePriorityCache(), resetAccountStateForTests(), invalidateAccountsCache() (+29 more)

### Community 77 - "package.json"
Cohesion: 0.11
Nodes (17): author, bugs, url, description, files, homepage, keywords, license (+9 more)

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

### Community 82 - "paths.ts"
Cohesion: 0.25
Nodes (16): dotenv, ensureDataDirs(), getAccountPriorityPath(), getDataDir(), getDbDir(), getDbPath(), getEncryptionKeyPath(), getEnvFilePath() (+8 more)

### Community 83 - "context-meter.ts"
Cohesion: 0.19
Nodes (15): getModelContextWindowSource(), BuildContextMeterInput, buildContextMeterSnapshot(), ContextMeterOptions, enrichUsageWithContextMeter(), getReservedOutputTokens(), MeteredUsage, roundPercent() (+7 more)

### Community 84 - "domain/types.ts"
Cohesion: 0.10
Nodes (8): AccountStatus, LeaseOwnershipSnapshot, LifecycleTransition, TERMINAL_ATTEMPT_STATES, WarmupState, FakeAccount, FakeOwnership, makePool()

### Community 87 - "ManagedStream"
Cohesion: 0.08
Nodes (9): GenerationStreamSource, FakeStream, FakeStreams, setup(), TrackedRuntime, CreateStreamInput, DeadlineCascade, ManagedStream (+1 more)

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
Cohesion: 0.13
Nodes (9): createGeneration(), AccountLeaseRow, ensuredOutcomeColumn, ensureOutcomeColumn(), EXTRA_COLUMNS, LeaseRepository, LeaseRow, LeaseState (+1 more)

### Community 92 - "maskEmail"
Cohesion: 0.30
Nodes (13): listAccounts(), maskEmail(), addAccountFlow(), askQuestion(), clear(), removeAccountFlow(), rl, showMenu() (+5 more)

### Community 95 - "getBasicHeaders"
Cohesion: 0.20
Nodes (19): fetchJsonInBrowser(), acquireAccountMutex(), closePlaywrightContextBestEffort(), getBasicHeaders(), getCookies(), getCookieSnapshot(), getErrorMessage(), hasRequiredQwenHeaders() (+11 more)

### Community 96 - ".tryRecoverToolCall"
Cohesion: 0.20
Nodes (9): coerceParameterValue(), decodeXmlEntities(), extractToolName(), getToolDefinitionName(), getToolDefinitionProperties(), inferToolNameFromParameters(), normalizeToolNameForMatch(), parseRecoverableXmlToolCall() (+1 more)

### Community 97 - "dependencies"
Cohesion: 0.20
Nodes (10): dependencies, ali-oss, better-sqlite3, dotenv, hono, @hono/node-server, patchright, tsx (+2 more)

### Community 98 - "update-cli.ts"
Cohesion: 0.33
Nodes (8): detectPackageManager(), __dirname, getUpdateArgs(), isNewerVersion(), packageJsonPath, PackageManager, packageRoot, runUpdateCommand()

### Community 99 - "proxy-client.ts"
Cohesion: 0.22
Nodes (6): cachedAccounts, DEFAULT_FALLBACK_MODELS, fetchProxyStatus(), maskAccountIdentifier(), resetAccountCooldownById(), AccountsView

### Community 100 - "vectorStore.ts"
Cohesion: 0.21
Nodes (8): tokenize(), bm25Score(), ensureTable(), Entry, getVectorStore(), resetVectorStoreForTests(), VectorHit, VectorStore

### Community 101 - "chat/context.ts"
Cohesion: 0.23
Nodes (11): ChatMode, BuildContextParams, buildFinalContext(), detectTitleGenerationRequest(), detectTrailingToolResult(), extractMessageText(), FinalContext, isContinuationMessage() (+3 more)

### Community 102 - "auth-playwright.ts"
Cohesion: 0.15
Nodes (25): getSettings(), label(), main(), post(), SAFE_SETTINGS_PATCH, sha(), main(), main() (+17 more)

### Community 105 - "model-aware-context-budget.test.ts"
Cohesion: 0.20
Nodes (10): getModelMaxCot(), getModelMaxInput(), getModelMaxInputThinking(), buildCompressedFailoverPrompt(), registryCapabilitySource(), TIERED_DEFAULT_BUDGET, registerQwen38Max(), computeInputContextBudget() (+2 more)

### Community 106 - "ids.ts"
Cohesion: 0.28
Nodes (11): newAttemptId(), newEventId(), newGenerationId(), newLeaseId(), newMessageId(), newOperationId(), newOwnerToken(), newRequestId() (+3 more)

### Community 107 - "config.ts"
Cohesion: 0.08
Nodes (21): getP50Ttfb(), Config, env, envSchema, app, CompletionsBody, completionsError(), completionsLegacy() (+13 more)

### Community 108 - "models.ts"
Cohesion: 0.23
Nodes (9): app, baseModelId(), expandModelVariants(), loadModelsWithVariants(), PublicModel, toAnthropicModel(), getModelCapabilities(), isAlwaysThinkingModel() (+1 more)

### Community 109 - "performanceMetrics"
Cohesion: 0.33
Nodes (3): performanceMetrics, RequestMetrics, RollingStats

### Community 110 - "context-compressor.ts"
Cohesion: 0.23
Nodes (9): bm25Rank(), buildSummary(), Chunk, chunkExchanges(), compressContextForFailover(), CompressResult, ParsedExchange, parseExchanges() (+1 more)

### Community 111 - "agenticStress.test.ts"
Cohesion: 0.24
Nodes (7): @hono/node-server, getFreePort(), isPortAvailable(), localTools, toolDefinitions, getFreePort(), isPortAvailable()

### Community 113 - "ali-oss.d.ts"
Cohesion: 0.29
Nodes (4): ali-oss, OSS, OSSOptions, PutOptions

### Community 115 - "logger"
Cohesion: 0.35
Nodes (3): logger, capture(), Session

### Community 116 - "devDependencies"
Cohesion: 0.50
Nodes (4): devDependencies, @types/better-sqlite3, @types/node, typescript

### Community 117 - "app"
Cohesion: 0.13
Nodes (4): app, CapturedChatRequest, NON_STREAM_CHAT_RESPONSE, modelsPayload

### Community 118 - "cli.test.ts"
Cohesion: 0.50
Nodes (3): binPath, __dirname, packageRoot

### Community 119 - "stop.ts"
Cohesion: 0.35
Nodes (7): createError(), activeStreams, getStream(), getStreamKeyBySessionAndResponse(), getStreamKeysBySessionId(), removeStream(), chatCompletionsStop()

### Community 120 - "memory-cache.ts"
Cohesion: 0.33
Nodes (3): CacheEntry, CacheKey, compressAsync

### Community 122 - "repository"
Cohesion: 0.67
Nodes (3): repository, type, url

### Community 136 - "parser.test.ts"
Cohesion: 0.50
Nodes (3): EDIT_FILE_TOOLS, FLAT_TOOLS, TOOLS

## Knowledge Gaps
- **626 isolated node(s):** `require`, `__dirname`, `packageRoot`, `packageJsonPath`, `rawArgs` (+621 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 977 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **26 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Config` connect `config.ts` to `qwen.ts`, `playwright.ts`, `account.ts`, `chat/streaming.ts`, `media-generation.ts`, `core/errors.ts`, `account-manager.ts`, `server.ts`, `sync/index.ts`, `qwenUrl`, `chat/index.ts`, `anthropic/index.ts`, `prompt-limits.ts`, `captcha-solver.ts`, `session-keeper.ts`, `retry-policy.ts`, `app.ts`, `utils/types.ts`, `metrics`, `initPlaywrightForAccount`, `construct.ts`, `forge-import.test.ts`, `qwen-chat-pool.ts`, `upload.ts`, `readiness-guard.ts`, `chat/validation.ts`, `retry-coordinator.ts`, `responses/index.ts`, `getDatabase`, `context-meter.ts`, `maskEmail`, `proxy-client.ts`, `chat/context.ts`, `auth-playwright.ts`, `context-compressor.ts`, `app`, `memory-cache.ts`?**
  _High betweenness centrality (0.077) - this node is a cross-community bridge._
- **Why does `getDatabase()` connect `getDatabase` to `generation-coordinator.ts`, `GenerationRepository`, `accounts.ts`, `qwen.ts`, `message-repository.ts`, `account.ts`, `chat/streaming.ts`, `account-manager.ts`, `server.ts`, `chat/index.ts`, `migrations.ts`, `session-repository.ts`, `forge-import.test.ts`, `stickyMap.ts`, `readiness-guard.ts`, `context/summary.ts`, `responses/index.ts`, `lease-repository.ts`, `vectorStore.ts`, `auth-playwright.ts`?**
  _High betweenness centrality (0.035) - this node is a cross-community bridge._
- **Why does `StreamingToolParser` connect `StreamingToolParser` to `.tryRecoverToolCall`, `retry-policy.ts`, `parser.test.ts`, `tool-recovery-t1t2.test.ts`, `parser-truncated-tool-call.test.ts`, `chat/streaming.ts`, `parser.ts`, `t3-close-tag-escape.test.ts`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **What connects `require`, `__dirname`, `packageRoot` to the rest of the system?**
  _626 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `generation-coordinator.test.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.09574468085106383 - nodes in this community are weakly interconnected._
- **Should `generation-coordinator.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.08552188552188553 - nodes in this community are weakly interconnected._
- **Should `driver.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.043745727956254275 - nodes in this community are weakly interconnected._