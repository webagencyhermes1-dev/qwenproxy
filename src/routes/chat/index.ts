/**
 * Thin orchestrator for chat completions. Delegates to specialized modules:
 * - validation.ts: request parsing
 * - context.ts: prompt building and topic analysis
 * - account.ts: upstream stream acquisition with failover
 * - streaming.ts: response processing (SSE/JSON)
 */

import type { Context } from "hono";
import { parseRequestBody } from "./validation.ts";
import { buildFinalContext } from "./context.ts";
import {
  acquireUpstreamStream,
  acquireChatLock,
  buildCompressedFailoverPrompt,
  quarantineChallengedAccountOnce,
  createRequestRetryContext,
} from "./account.ts";
import {
  abortLeaseBySessionLabel,
  hasUnemittedSessionStream,
} from "../../core/account-concurrency.ts";
import {
  processNonStreamingResponse,
  processStreamingResponse,
  handleChatCompletionsError,
  type AssistantCompleteEvent,
} from "./streaming.ts";
import { config, type ChatMode } from "../../core/config.ts";
import { logger } from "../../core/logger.ts";
import { getContextMeterHeaders, type ContextMeterMode } from "../../services/context-meter.ts";
import {
  getLogicalThreadState,
  invalidateLogicalThreadParent,
  RetryableQwenStreamError,
} from "../../services/qwen.ts";
import {
  classifyRetryAction,
  shouldRetryInvalidInputOnSameAccount,
} from "./retry-policy.ts";
import { classifyMediaModel } from "../../services/media-generation.ts";
import { handleMediaChatCompletion } from "./media.ts";
import { getStickyMap } from "../../services/session/stickyMap.ts";
import { generateStickyKey } from "../../services/session/key.ts";
import { getHealthTracker, classify429 } from "../../services/account/health.ts";
import { isAntiBotError } from "./retry-policy.ts";



function formatTimingHeader(timings: Record<string, number>): string {
  return Object.entries(timings)
    .map(([key, value]) => `${key}=${Math.max(0, Math.round(value))}`)
    .join(";");
}

/**
 * Per-request chat-mode override (X-QwenProxy-Chat-Mode) falls back to the
 * QWEN_CHAT_MODE env default. Only the two known modes are accepted; anything
 * else silently uses the configured default.
 */
function resolveChatMode(headerValue: string | undefined): ChatMode {
  if (headerValue === "thread" || headerValue === "temp" || headerValue === "temp-thread") {
    return headerValue;
  }
  if (headerValue === "temp_thread") {
    return "temp-thread";
  }
  return config.qwen.chatMode;
}

export async function chatCompletions(c: Context) {
  let releaseChatLock: (() => void) | null = null;
  const startedAt = Date.now();
  const timings: Record<string, number> = {};
  const mark = (name: string, since: number) => {
    timings[name] = Date.now() - since;
  };
  // Last account that served (or attempted) this request, for health scoring
  // in the outer catch when the stream result is out of scope.
  let lastActiveAccountId: string | null = null;
  const currentStreamAccountIdForHealth = (): string | null => lastActiveAccountId;

  try {
    let stepStartedAt = Date.now();
    const parsed = await parseRequestBody(c);
    mark("parse", stepStartedAt);
    const {
      body,
      isStream,
      systemPrompt,
      toolInstructions,
      prompt,
      currentPrompt,
      modelId,
      enableThinking,
      reasoningMode,
      allFiles,
      currentFiles,
      shouldParseToolCalls,
      conversationKey,
    } = parsed;

    const messages = body.messages || [];
    const declaredTools = Array.isArray((body as any).tools)
      ? (body as any).tools
      : [];

    // Correlate arrival and dispatch: logged again on the 📤 line once the
    // upstream stream (and its queue wait) is resolved.
    const reqId = crypto.randomUUID().substring(0, 8);
    const reqStartedAt = Date.now();
    const routeLabel = c.req.header("x-qwenproxy-route") || "Chat";
    console.log(
      `📥 [${routeLabel}] Incoming | req=${reqId} | ${body.model} | ${messages.length} msg(s) | stream=${isStream}${declaredTools.length ? ` | ${declaredTools.length} tool(s)` : ""}${allFiles.length ? ` | ${allFiles.length} file(s)` : ""}`,
    );

    // Intercept image/video generation models: they bypass the text chat flow
    // and are handled by the native media pipeline (qwen-image-*, wan2.*).
    const rawModel = typeof body.model === "string" ? body.model.trim() : "";
    const mediaKind = rawModel ? classifyMediaModel(rawModel) : null;
    if (mediaKind) {
      return handleMediaChatCompletion({
        c,
        body,
        model: rawModel,
        kind: mediaKind,
        isStream,
      });
    }

    stepStartedAt = Date.now();
    const chatMode = resolveChatMode(c.req.header("x-qwenproxy-chat-mode"));
    const ctx = await buildFinalContext({
      messages,
      systemPrompt,
      toolInstructions,
      prompt,
      currentPrompt,
      modelId,
      enableThinking,
      conversationKey,
      hasExplicitConversationKey: parsed.hasExplicitConversationKey,
      chatMode,
    });
    mark("context", stepStartedAt);

    // Loop 2: deterministic sticky key (header > first_message > combined > random).
    // Lookup-only: touch on hit for sliding TTL, no routing change yet.
    // Rebind lands in Loop 8. Exposed via c.set for downstream account layer.
    let stickyKey: string | null = null;
    try {
      stickyKey = generateStickyKey({
        sessionHeader:
          c.req.header("x-session-id") ?? c.req.header("X-Session-Id"),
        explicitKey: conversationKey,
        systemPrompt,
        messages,
      });
      c.set("stickyKey" as never, stickyKey as never);
      const observed = getStickyMap().get(stickyKey);
      if (observed) {
        getStickyMap().touch(stickyKey);
        if (logger.isLevelEnabled("info")) {
          console.log(
            `[Session] Lookup hit | key=${stickyKey} | account=${observed.accountId} | session=${ctx.sessionId}`,
          );
        }
      } else if (stickyKey) {
        // Loop 4 (advisory): health-aware pick for new sessions. The
        // authoritative pick still lives in account.ts scheduler; this log
        // proves the new selector agrees without changing routing yet.
        try {
          const { loadAccounts } = await import("../../core/accounts.ts");
          const { selectAccountForNewSession } = await import(
            "../../services/account/selection.ts"
          );
          const ids = loadAccounts().map((a) => a.id);
          const advisory = selectAccountForNewSession({
            stickyMap: getStickyMap(),
            healthTracker: getHealthTracker(),
            availableAccounts: ids,
            stickyKey,
          });
          if (advisory && logger.isLevelEnabled("info")) {
            console.log(
              `[Session] Advisory pick | key=${stickyKey} | account=${advisory} | pool_size=${ids.length}`,
            );
          }
        } catch {
          // Best-effort.
        }
      }
    } catch {
      // Observability only; never fail the request.
    }

    // Chat lock is acquired AFTER stream creation (below) to avoid holding it
    // during account selection, retries, and anti-bot recovery which can take
    // 30s+. Holding it here caused 190s+ lock contention cascading to all
    // subsequent requests on the same chat.
    mark("lock", stepStartedAt);

    let finalPrompt = ctx.finalPrompt;
    mark("thread", stepStartedAt);

    const files = ctx.useThreadNative ? currentFiles : allFiles;

    const msgCount =
      ctx.useThreadNative && !ctx.isNewSession
        ? parsed.currentMessageCount
        : parsed.messageCount;

    const personalizationChars =
      ctx.requestPersonalizationInstruction?.length ?? 0;
    logger.debug("[chat] request routing details", {
      model: body.model,
      messages: msgCount,
      promptChars: finalPrompt.length,
      tools: declaredTools.length,
      files: files.length,
      personalizationChars,
      sessionId: ctx.sessionId,
      useThreadNative: ctx.useThreadNative,
      isNewSession: ctx.isNewSession,
      hasExplicitConversationKey: ctx.hasExplicitConversationKey,
      allowThreadReuse: ctx.allowThreadReuse,
      sessionIdentitySource: parsed.hasExplicitConversationKey
        ? typeof body.session_id === "string" &&
          body.session_id.trim().length > 0
          ? "session_id"
          : "conversation_id"
        : ctx.isNewSession
          ? "none-new-chat"
          : "implicit-continuation",
    });

    stepStartedAt = Date.now();
    // Full replay carries the conversation only: agent instructions ride the
    // account-level personalization, which is confirmed on the destination
    // account BEFORE the replayed completion is sent (an unconfirmed sync now
    // fails the attempt instead of degrading to inline). Title generation does
    // not sync personalization and keeps the legacy inline replay.
    const fullPromptForRequest =
      ctx.requestPersonalizationInstruction !== null
        ? parsed.prompt
        : [parsed.systemPrompt, parsed.toolInstructions, parsed.prompt]
            .filter((part) => part.trim().length > 0)
            .join("\n\n");
    const initialContextMode: ContextMeterMode = ctx.existingThread
      ? "delta"
      : "full";

    // Same-session latest-wins BEFORE the per-chat lock and BEFORE the stream
    // acquisition: the client can fire the next turn while the previous stream
    // is still open (streaming tool calls). Killing the stale generation first
    // frees the account slot + chat lock immediately instead of queueing.
    // onlyIfEmitted: a stream that has NOT emitted a chunk yet is protected —
    // a parallel request (e.g. the client's title generation racing the main
    // request) must not waste the main generation. In that case this request
    // runs on its OWN chat (parallelEscape) instead of waiting on the main
    // chat's lock for minutes.
    let parallelEscape = false;
    if (ctx.allowThreadReuse && ctx.sessionId) {
      const superseded = abortLeaseBySessionLabel(ctx.sessionId, {
        onlyIfEmitted: true,
      });
      const existingThread = getLogicalThreadState(ctx.sessionId);
      const chatId = existingThread?.chatSessionId;
      // Escape ONLY when an unemitted stream is actually active (a lease
      // exists but was protected). No active lease (normal next turn) takes
      // the regular path.
      parallelEscape =
        !!chatId && !superseded && hasUnemittedSessionStream(ctx.sessionId);
      if (parallelEscape && logger.isLevelEnabled("info")) {
        console.log(
          `🔀 [Chat] Parallel escape | req=${reqId} | session=${ctx.sessionId} | chat=${chatId?.substring(0, 12)} | own chat`,
        );
      }
      if (chatId && !parallelEscape) {
        releaseChatLock = await acquireChatLock(chatId);
      }
    }

    // Create the authoritative per-request retry context shared across ALL
    // retry layers (inner, outer, mid-stream, request-level). This is the
    // single source of truth for which accounts have been tried and how much
    // global retry budget remains.
    const retryCtx = createRequestRetryContext();

    let streamResult = await acquireUpstreamStream({
      finalPrompt,
      fullPrompt: fullPromptForRequest,
      isThinkingModel: ctx.isThinkingModel,
      model: modelId,
      reasoningMode,
      contextModelId: modelId,
      shouldResetUpstreamThread: ctx.shouldResetUpstreamThread,
      allFiles: files,
      isNewSession: ctx.isNewSession,
      sessionId: ctx.sessionId,
      useThreadNative: ctx.useThreadNative,
      updateLogicalThread: parallelEscape ? false : ctx.updateLogicalThread,
      allowThreadReuse: ctx.allowThreadReuse,
      forceNewChat: parallelEscape,
      preferredAccountId: undefined,
      messageCount: msgCount,
      fullMessageCount: parsed.messageCount,
      toolsCount: declaredTools.length || undefined,
      requestPersonalizationInstruction: ctx.requestPersonalizationInstruction,
      contextMode: initialContextMode,
      requestSignal: c.req.raw.signal,
      messages,
      systemPrompt,
      toolInstructions,
      tools: declaredTools,
      stickyKey,
      parallelEscape,
      chatMode,
      retryContext: retryCtx,
    });



    mark("upstream", stepStartedAt);
    timings.preResponse = Date.now() - startedAt;
    c.header("X-QwenProxy-Timing", formatTimingHeader(timings));

    if ("error" in streamResult) {
      if (streamResult.allOnCooldown) {
        const err: any = new Error(
          `All configured accounts are on cooldown. Retry in about ${Math.max(
            1,
            Math.ceil((streamResult.retryAfterMs ?? 0) / 1000),
          )}s.`,
        );
        err.upstreamStatus = 429;
        throw err;
      }
      throw streamResult.error || new Error("All accounts failed");
    }
    lastActiveAccountId = streamResult.activeAccountId;

    // Loop 8: sticky set/rebind on success. First turn binds; account mismatch
    // (failover inside account.ts) rebinds with compressed-context validation.
    // Same-account turns keep thread-native delta (only touch).
    if (stickyKey) {
      try {
        const sm = getStickyMap();
        const existing = sm.get(stickyKey);
        if (!existing) {
          const { STICKY_TTL_MS } = await import("../../services/session/stickyMap.ts");
          sm.set(stickyKey, {
            accountId: streamResult.activeAccountId,
            proxyId: null,
            boundAt: Date.now(),
            lastUsedAt: Date.now(),
            ttlMs: STICKY_TTL_MS,
          });
        } else if (existing.accountId !== streamResult.activeAccountId) {
          // Failover: validate compressed payload fits 100k via tiered assembly
          // (string replay already compressed in account.ts; this is the
          // Message-level check + refs for reversibility).
          try {
            const { assembleCompressedContext } = await import(
              "../../services/context/tiered.ts"
            );
            const { getRollingSummary } = await import(
              "../../services/context/summary.ts"
            );
            const lastMsg = messages[messages.length - 1] ?? {
              role: "user",
              content: currentPrompt || prompt,
            };
            const compressed = assembleCompressedContext({
              systemPrompt,
              tools: Array.isArray((body as unknown as { tools?: [] }).tools)
                ? ((body as unknown as { tools: [] }).tools as never)
                : [],
              messages,
              currentTurn: lastMsg,
              rollingSummary: getRollingSummary().get(stickyKey),
              tokenBudget: 100_000,
            });
            console.warn(
              `[Session] Failover compressed | key=${stickyKey} | from=${existing.accountId} | to=${streamResult.activeAccountId} | total=${compressed.totalChars} | t2=${compressed.t2.length} | refs=${Object.keys(compressed.refs).length}`,
            );
          } catch (e) {
            console.warn(
              `[Session] Failover compression check failed | key=${stickyKey} | error=${e instanceof Error ? e.message : String(e)}`,
            );
          }
          sm.rebind(stickyKey, streamResult.activeAccountId, null);
        } else {
          sm.touch(stickyKey);
        }
        // Async non-blocking index/summary for future T2/T3 (never blocks).
        void (async () => {
          try {
            const { getVectorStore } = await import("../../services/context/vectorStore.ts");
            const { getRollingSummary } = await import("../../services/context/summary.ts");
            const lastMsg = messages[messages.length - 1];
            if (lastMsg) {
              const text =
                typeof lastMsg.content === "string"
                  ? lastMsg.content
                  : JSON.stringify(lastMsg.content ?? "");
              await getVectorStore().add(stickyKey!, `${Date.now()}-${reqId}`, text.slice(0, 8000));
            }
            await getRollingSummary().update(stickyKey!, messages.slice(-4) as never);
          } catch {
            // Best-effort.
          }
        })();
      } catch {
        // Best-effort.
      }
    }

    for (const [name, value] of Object.entries(
      getContextMeterHeaders(streamResult.tokenEstimationContext.contextMeter),
    )) {
      c.header(name, value);
    }

    // A failover replay (account switch / missing thread parent) hides its
    // real cost behind the thread-native delta numbers: surface it explicitly
    // so the 📤 line shows what was actually sent upstream (tiered compressed
    // context, 100k budget — never the raw full history).
    const replayed = streamResult.replayedFullContext === true;
    const replayedChars =
      replayed && typeof streamResult.failoverPromptChars === "number"
        ? streamResult.failoverPromptChars
        : fullPromptForRequest.length;
    console.log(
      `📤 [${routeLabel}] Request | req=${reqId} | ${streamResult.activeAccountLabel} | ${body.model} | ${replayed ? parsed.messageCount : msgCount} msg(s) | ${replayed ? replayedChars : finalPrompt.length} chars${replayed ? " | context=compressed" : ""} | chat=${streamResult.uiSessionId.substring(0, 12)}${declaredTools.length ? ` | ${declaredTools.length} tool(s)` : ""}${files.length ? ` | ${files.length} file(s)` : ""} | +${Date.now() - reqStartedAt}ms`,
    );

    const onAssistantComplete: ((event: AssistantCompleteEvent) => Promise<void> | void) | undefined = undefined;

    const params = {
      c,
      reqId,
      completionId: streamResult.completionId,
      stream: streamResult.stream,
      uiSessionId: streamResult.uiSessionId,
      activeAccountId: streamResult.activeAccountId,
      activeAccountLabel: streamResult.activeAccountLabel,
      logicalSessionId: streamResult.logicalSessionId,
      body,
      finalPrompt,
      userPrompt: currentPrompt || prompt,
      shouldParseToolCalls,
      declaredTools,
      tokenEstimationContext: streamResult.tokenEstimationContext,
      midStreamRetry: {
        fullPrompt: fullPromptForRequest,
        isThinkingModel: ctx.isThinkingModel,
        contextModelId: modelId,
        reasoningMode,
        activeAccountId: streamResult.activeAccountId,
        allFiles: files,
        isNewSession: ctx.isNewSession,
        sessionId: ctx.sessionId,
        useThreadNative: ctx.useThreadNative,
        // A parallel request (own chat) must not rebind the session thread on
        // mid-stream recovery — the main conversation owns it.
        updateLogicalThread: parallelEscape
          ? false
          : ctx.updateLogicalThread,
        parallelEscape,
        chatMode,
        allowThreadReuse: ctx.allowThreadReuse,
        messageCount: msgCount,
        fullMessageCount: parsed.messageCount,
        toolsCount: declaredTools.length || undefined,
        requestPersonalizationInstruction:
          ctx.requestPersonalizationInstruction,
        contextMode: initialContextMode as ContextMeterMode,
        releaseAccountLease: streamResult.releaseAccountLease,
        messages,
        systemPrompt,
        toolInstructions,
        tools: declaredTools,
        stickyKey,
        retryContext: retryCtx,
      },
      onAssistantComplete,
      onStreamComplete: () => {
        if (releaseChatLock) {
          releaseChatLock();
          releaseChatLock = null;
        }
        // Loop 3: record success for health scoring (TTFB approx = acquire time;
        // precise first-chunk timing lands in Loop 8 via streaming layer).
        try {
          getHealthTracker().recordSuccess(
            streamResult.activeAccountId,
            Date.now() - reqStartedAt,
          );
        } catch {
          // Best-effort.
        }
        streamResult.releaseAccountLease();
      },
    };

    // Retry loop for mid-stream/create-stream failures (generic policy)
        let streamProcessingRetries = Math.max(0, config.retry.maxAttempts - 1);
        let invalidInputSameAccountRetries = 0;
        let currentStreamResult = streamResult;
        let currentParams = params;
        // Use the shared per-request retry context — the tried set is shared
        // across ALL retry layers so no layer can forget a failed account.
        retryCtx.triedAccountIds.add(streamResult.activeAccountId);

        while (true) {
          try {
            return isStream
              ? await processStreamingResponse(currentParams)
              : await processNonStreamingResponse(currentParams);
          } catch (streamErr: any) {
            const policy = classifyRetryAction(streamErr, {
              requestAborted: c.req.raw.signal.aborted,
            });

            // Full decision context for the outer retry loop (same rationale as
            // the create-path policy log): the error line shows WHAT failed, this
            // shows WHY the retry action was chosen.
            if (logger.isLevelEnabled("info")) {
              console.log(
                `🧭 [Chat] Stream retry policy | req=${reqId} | reason=${policy.reason} | retryable=${policy.retryable} | switch=${policy.switchAccount} | newChat=${policy.forceNewChat} | retryAfter=${policy.retryAfterMs}ms`,
              );
            }

            if (policy.reason === "corrupted_chat_history") {
              invalidateLogicalThreadParent(ctx.sessionId);
            }

            // Loop 9: burst vs quota health feed. Burst (temporary, same-account
            // retry) must NOT rebind; quota must. Recording here keeps the
            // HealthTracker in sync even when the retry succeeds on same/new acct.
            try {
              const acct = currentStreamResult.activeAccountId;
              if (policy.reason === "quota_or_rate_limit" && acct) {
                const kind = policy.switchAccount ? "quota" : "burst";
                getHealthTracker().record429(acct, kind as "burst" | "quota", policy.retryAfterMs);
                if (kind === "burst" && logger.isLevelEnabled("info")) {
                  console.log(
                    `[Session] Burst pace, no rebind | account=${acct} | retryAfter=${policy.retryAfterMs}ms | key=${stickyKey ?? "n/a"}`,
                  );
                }
              } else if (policy.reason === "anti_bot" && currentStreamResult.activeAccountId) {
                getHealthTracker().recordCaptcha(currentStreamResult.activeAccountId);
              }
            } catch {
              // Best-effort.
            }

            if (policy.reason === "chat_in_progress") {
              // The same-chat settle budget AND the single bounded escalation
              // (fresh chat + full replay) were already spent at the create path
              // before this error surfaced. A request-level retry would restart
              // that whole budget and replay the full context again. Surface the
              // error; the inner loop already cleared the origin binding, so the
              // client's own retry starts a fresh chat.
              throw streamErr;
            }

            // Prefer explicit RetryableQwenStreamError OR generic retryable policy
            const canRetry =
              streamProcessingRetries > 0 &&
              policy.retryable &&
              (streamErr instanceof RetryableQwenStreamError ||
                config.retry.onUnknownUpstream !== false);

            if (!canRetry) {
              // Terminal (or retry budget exhausted): say WHY instead of just
              // letting the error bubble to handleChatCompletionsError — the
              // operator must distinguish "upstream refused" from "our retry
              // budget ran out".
              if (logger.isLevelEnabled("info")) {
                console.log(
                  `⛔ [Chat] Stream retry exhausted | req=${reqId} | reason=${policy.reason} | retriesLeft=${streamProcessingRetries} | retryable=${policy.retryable} | error=${streamErr?.message?.substring(0, 150)}`,
                );
              }
              throw streamErr;
            }

            streamProcessingRetries--;
            console.warn(
              `[Chat] Stream processing error, retrying with new stream | reason=${policy.reason} | ${streamErr.message?.substring(0, 150)} | retries left: ${streamProcessingRetries}`,
            );

            // Recover a generic invalid_input on the same account once by
            // creating a clean upstream chat. A second failure may rotate.
            const retryInvalidInputOnSameAccount =
              shouldRetryInvalidInputOnSameAccount(
                policy.reason,
                invalidInputSameAccountRetries > 0,
              );
            if (retryInvalidInputOnSameAccount) {
              invalidInputSameAccountRetries++;
            }
            const switchAccount =
              policy.switchAccount && !retryInvalidInputOnSameAccount;
            const forceRetryNewChat = policy.forceNewChat;
            const retryWithFullPrompt = policy.retryWithFullPrompt;
            const retryFiles = policy.dropFiles ? [] : files;

            // Merge nested tried sets so challenged accounts stay excluded.
            try {
              const nested = (streamErr as Record<string, unknown>)["triedAccountIds"];
              if (Array.isArray(nested)) {
                for (const id of nested) if (typeof id === "string") retryCtx.triedAccountIds.add(id);
              }
            } catch {
              // Best-effort.
            }
            retryCtx.triedAccountIds.add(currentStreamResult.activeAccountId);
            try {
              (streamErr as Record<string, unknown>)["triedAccountIds"] = [...retryCtx.triedAccountIds];
            } catch {
              // Best-effort.
            }

            if (policy.reason === "anti_bot") {
              // Authoritative request-level failover: quarantine once via WAF
              // isolation, never retry the challenged account for this request.
              quarantineChallengedAccountOnce(
                streamErr,
                currentStreamResult.activeAccountId,
                currentStreamResult.activeAccountLabel || currentStreamResult.activeAccountId,
                { completionId: currentStreamResult.completionId },
              );
              console.warn(
                `[Account Failover] | from=${currentStreamResult.activeAccountLabel} | reason=anti_bot | req=${reqId} | tried=[${[...retryCtx.triedAccountIds].join(",")}]`,
              );
            } else if (
              // Do not cooldown an account when the policy is retrying it in
              // place (temporary load shedding). A cooldown here would make the
              // subsequent preferred-account retry skip that same account.
              policy.switchAccount &&
              (policy.accountCooldownMs || policy.accountCooldownReason)
            ) {
              const { markAccountRateLimited } =
                await import("../../core/account-manager.ts");
              markAccountRateLimited(
                currentStreamResult.activeAccountId,
                policy.accountCooldownMs,
                policy.accountCooldownReason || "StreamRetry",
              );
              try {
                const { recordAccountFailure } = await import(
                  "../../core/account-health.ts"
                );
                const reason = policy.accountCooldownReason ?? "";
                recordAccountFailure(
                  currentStreamResult.activeAccountId,
                  reason === "RateLimitTemporary"
                    ? "rate_limit"
                    : /quota|RateLimited/i.test(reason)
                      ? "quota"
                      : /waf|challenge|captcha/i.test(
                          `${reason} ${policy.reason}`,
                        )
                        ? "waf"
                        : "network",
                );
              } catch {
                // Best-effort.
              }
            }

            // Release current chat lock and account lease before retrying
            if (releaseChatLock) {
              releaseChatLock();
              releaseChatLock = null;
            }
            currentStreamResult.releaseAccountLease();

            // Account switch always rebuilds compressed history (tiered T1+T2+T3);
            // same-account retry only does so when the policy asks for
            // forceNewChat/full prompt.
            const needsFullPromptOnRetry =
              retryWithFullPrompt || switchAccount || forceRetryNewChat;
            const retryFinalPrompt = needsFullPromptOnRetry
              ? buildCompressedFailoverPrompt({
                  systemPrompt,
                  toolInstructions,
                  tools: declaredTools,
                  messages,
                  fallbackQuery: finalPrompt,
                  stickyKey,
                  usePersonalization: ctx.requestPersonalizationInstruction != null,
                  reason: `request-retry:${policy.reason}`,
                })
              : finalPrompt;
            const retryMessageCount = needsFullPromptOnRetry
              ? parsed.messageCount
              : msgCount;

            if (forceRetryNewChat || switchAccount) {
              console.warn(
                `[Chat] Retry will force a new upstream chat and resend compressed context | ${streamErr.message?.substring(0, 150)}`,
              );
            }
            if (switchAccount) {
              console.warn(
                `[Chat] Retry will prefer another account when available | ${streamErr.message?.substring(0, 150)}`,
              );
            }

            if (policy.retryAfterMs > 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, Math.min(policy.retryAfterMs, 3000)),
              );
            }

            // Same-session latest-wins before re-acquiring: protects an
            // unemitted generation (parallel title request) which then runs on
            // its own chat via retryParallelEscape.
            let retryParallelEscape = false;
            if (ctx.allowThreadReuse && ctx.sessionId) {
              const superseded = abortLeaseBySessionLabel(ctx.sessionId, {
                onlyIfEmitted: true,
              });
              const existingThread = getLogicalThreadState(ctx.sessionId);
              const chatId = existingThread?.chatSessionId;
              retryParallelEscape =
                parallelEscape ||
                (!!chatId &&
                  !superseded &&
                  hasUnemittedSessionStream(ctx.sessionId));
              if (retryParallelEscape && logger.isLevelEnabled("info")) {
                console.log(
                  `🔀 [Chat] Parallel escape (retry) | req=${reqId} | session=${ctx.sessionId} | chat=${chatId?.substring(0, 12)} | own chat`,
                );
              }
              if (chatId && !retryParallelEscape) {
                releaseChatLock = await acquireChatLock(chatId);
              }
            }

            // Re-acquire stream with different account or a fresh upstream chat
            const newStreamResult = await acquireUpstreamStream({
              finalPrompt: retryFinalPrompt,
              fullPrompt: fullPromptForRequest,
              isThinkingModel: ctx.isThinkingModel,
              model: modelId,
              contextModelId: modelId,
              shouldResetUpstreamThread: ctx.shouldResetUpstreamThread,
              allFiles: retryFiles,
              isNewSession: ctx.isNewSession,
              sessionId: ctx.sessionId,
              useThreadNative: ctx.useThreadNative,
              updateLogicalThread: retryParallelEscape
                ? false
                : ctx.updateLogicalThread,
              allowThreadReuse: ctx.allowThreadReuse,
              forceNewChat:
                forceRetryNewChat || switchAccount || retryParallelEscape,
              preferredAccountId: switchAccount
                ? null
                : currentStreamResult.activeAccountId,
              excludeAccountIds: switchAccount
                ? [...retryCtx.triedAccountIds]
                : undefined,
              messageCount: retryMessageCount,
              fullMessageCount: parsed.messageCount,
              toolsCount: declaredTools.length || undefined,
              requestPersonalizationInstruction:
                ctx.requestPersonalizationInstruction,
              contextMode: needsFullPromptOnRetry ? "replay" : initialContextMode,
              requestSignal: c.req.raw.signal,
              messages,
              systemPrompt,
              toolInstructions,
              tools: declaredTools,
              stickyKey,
              parallelEscape: retryParallelEscape,
              chatMode,
              retryContext: retryCtx,
            });

            if ("error" in newStreamResult) {
              // Prefer a local preflight error over the upstream error that
              // triggered the replay (for example, an oversized full context).
              throw newStreamResult.error ?? streamErr;
            }

            for (const [name, value] of Object.entries(
              getContextMeterHeaders(
                newStreamResult.tokenEstimationContext?.contextMeter,
              ),
            )) {
              c.header(name, value);
            }

            console.log(
              `🔄 [Chat] Request routed | ${newStreamResult.activeAccountLabel} | ${body.model} | ${retryMessageCount} msg(s) | ${retryFinalPrompt.length} chars${needsFullPromptOnRetry ? " | context=compressed" : ""} | chat=${newStreamResult.uiSessionId.substring(0, 12)}${declaredTools.length ? ` | ${declaredTools.length} tool(s)` : ""}${files.length ? ` | ${files.length} file(s)` : ""} | retry | +${Date.now() - reqStartedAt}ms`,
            );
            if (policy.reason === "anti_bot") {
              console.warn(
                `[Replacement Account Selected] | account=${newStreamResult.activeAccountLabel} (${newStreamResult.activeAccountId}) | reason=anti_bot | req=${reqId}`,
              );
              console.warn(
                `[Retry Started] | reason=anti_bot | account=${newStreamResult.activeAccountLabel} | req=${reqId} | freshChat=true | compressedContext=true`,
              );
            }
            retryCtx.triedAccountIds.add(newStreamResult.activeAccountId);
            lastActiveAccountId = newStreamResult.activeAccountId;
            // Loop 8: keep sticky binding aligned on retry failover.
            if (stickyKey) {
              try {
                const sm = getStickyMap();
                const existing = sm.get(stickyKey);
                if (!existing) {
                  const { STICKY_TTL_MS } = await import(
                    "../../services/session/stickyMap.ts"
                  );
                  sm.set(stickyKey, {
                    accountId: newStreamResult.activeAccountId,
                    proxyId: null,
                    boundAt: Date.now(),
                    lastUsedAt: Date.now(),
                    ttlMs: STICKY_TTL_MS,
                  });
                } else if (existing.accountId !== newStreamResult.activeAccountId) {
                  sm.rebind(stickyKey, newStreamResult.activeAccountId, null);
                } else {
                  sm.touch(stickyKey);
                }
              } catch {
                // Best-effort.
              }
            }

            currentStreamResult = newStreamResult;
            currentParams = {
              c,
              reqId,
              completionId: newStreamResult.completionId,
              stream: newStreamResult.stream,
              uiSessionId: newStreamResult.uiSessionId,
              activeAccountId: newStreamResult.activeAccountId,
              activeAccountLabel: newStreamResult.activeAccountLabel,
              logicalSessionId: newStreamResult.logicalSessionId,
              body,
              finalPrompt: retryFinalPrompt,
              userPrompt: currentPrompt || prompt,
              shouldParseToolCalls,
              declaredTools,
              tokenEstimationContext: newStreamResult.tokenEstimationContext,
              midStreamRetry: {
                fullPrompt: fullPromptForRequest,
                isThinkingModel: ctx.isThinkingModel,
                contextModelId: modelId,
                reasoningMode,
                activeAccountId: newStreamResult.activeAccountId,
                allFiles: retryFiles,
                isNewSession: ctx.isNewSession,
                sessionId: ctx.sessionId,
                useThreadNative: ctx.useThreadNative,
                updateLogicalThread: retryParallelEscape
                  ? false
                  : ctx.updateLogicalThread,
                parallelEscape: retryParallelEscape,
                chatMode,
                allowThreadReuse: ctx.allowThreadReuse,
                messageCount: retryMessageCount,
                fullMessageCount: parsed.messageCount,
                toolsCount: declaredTools.length || undefined,
                requestPersonalizationInstruction:
                  ctx.requestPersonalizationInstruction,
                contextMode: needsFullPromptOnRetry
                  ? "replay"
                  : initialContextMode,
                releaseAccountLease: newStreamResult.releaseAccountLease,
                messages,
                systemPrompt,
                toolInstructions,
                tools: declaredTools,
                stickyKey,
                retryContext: retryCtx,
              },
              onAssistantComplete,
              onStreamComplete: () => {
                if (releaseChatLock) {
                  releaseChatLock();
                  releaseChatLock = null;
                }
                newStreamResult.releaseAccountLease();
              },
            };
            continue;
          }
        }
  } catch (err) {
    timings.preResponse = Date.now() - startedAt;
    c.header("X-QwenProxy-Timing", formatTimingHeader(timings));
    if (releaseChatLock) {
      releaseChatLock();
      releaseChatLock = null;
    }

    // Loop 3: feed terminal errors into health scoring (burst vs quota).
    try {
      const anyErr = err as {
        upstreamStatus?: number;
        retryAfterMs?: number;
        message?: string;
        activeAccountId?: string;
      };
      const acct =
        anyErr?.activeAccountId ?? currentStreamAccountIdForHealth();
      if (acct && anyErr?.upstreamStatus === 429) {
        getHealthTracker().record429(
          acct,
          classify429(anyErr.retryAfterMs, anyErr.message),
          anyErr.retryAfterMs,
        );
      } else if (acct && err && isAntiBotError(err)) {
        getHealthTracker().recordCaptcha(acct);
      }
    } catch {
      // Best-effort.
    }

    // The client is already gone; do not turn expected cancellation into a
    // misleading 500/internal_server_error log or retry response.
    if (c.req.raw.signal.aborted) {
      logger.debug("[chat] request aborted before response", {
        error: err instanceof Error ? err.message : String(err),
      });
      return new Response(null, { status: 499 });
    }

    return handleChatCompletionsError(c, err);
  } finally {
    // Lock released via onStreamComplete when stream finishes
  }
}

export { chatCompletionsStop } from "./stop.ts";
