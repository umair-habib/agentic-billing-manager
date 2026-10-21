"use client";

import * as React from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  ArrowUp,
  Check,
  CircleAlert,
  Lightbulb,
  Loader2,
  MessageCircle,
  Mic,
  Plug,
  Sparkles,
  Square,
  Trash2,
  Volume2,
  VolumeX,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/common/empty-state";
import { FormAlert } from "@/components/common/form-alert";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { MarkdownMessage } from "@/components/agent/markdown-message";
import { AiRecommendations } from "@/components/ai/ai-recommendations";
import { cn } from "@/lib/utils";
import { ApiError } from "@/services/api/client";
import { sendAgentMessage } from "@/services/agent/agent-chat.service";
import { agentChatStore } from "@/services/agent/agent-chat-store";
import { getMyCredits } from "@/services/credits/credits.service";
import { readPageCache, writePageCache } from "@/lib/page-data-cache";
import { updateBillingRecord, deleteBillingRecord } from "@/services/billing/billing.service";
import type { BillingStatus } from "@/services/types/billing";
import type { CreditsData } from "@/services/types/credits";
import type { ConnectPlatformAction, AgentAction } from "@/services/types/agent";

/** Same cache key the top-level Billing page (`plan/plan-view.tsx`'s credits section)
 *  writes to for `GET /credits`'s full
 *  response — reused here (not a separate key) so the balance shown by
 *  either surface seeds instantly from whichever one fetched most recently,
 *  instead of the pill popping in late on every single Agent page visit
 *  while every other stat-bearing panel in the app avoids that via this
 *  same cache. */
const CREDITS_CACHE_KEY = "credits";
import type { Recommendation } from "@/services/types/recommendations";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { useSpeechSynthesis } from "@/hooks/use-speech-synthesis";

/** One-tap starter questions that showcase the agent's real tool-use. */
const SUGGESTED_PROMPTS = [
  "What's my total spend?",
  "How many platforms do I have connected?",
  "Can I connect Shopify?",
  "What platforms can you connect for me?",
];

const TABS = [
  { key: "chat", label: "Chat", icon: MessageCircle },
  { key: "recommendations", label: "Recommendations", icon: Lightbulb },
] as const;
type TabKey = (typeof TABS)[number]["key"];
const TAB_KEYS: readonly string[] = TABS.map((t) => t.key);

/** A clear, specific message for the chat's expected refusals — out of
 *  credits (403), a reply already in progress elsewhere, e.g. another tab or
 *  Slack (409), and too many requests (429) — instead of a generic error. */
function agentErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return "Failed to reach the agent. Please try again.";
  switch (err.status) {
    case 403:
      return "You've used all your credits. Add more credits to keep chatting with the Billing Advisor.";
    case 409:
      return "Still working on your previous question (maybe in another tab or in Slack). Wait for that reply, then send this again.";
    case 429:
      // Two distinct backend causes (per-minute limit vs. workspace busy) —
      // each already carries its own clear message.
      return err.message || "Too many requests right now. Please wait a moment and try again.";
    default:
      return err.message;
  }
}

/** Three-dot "thinking" pulse — quieter than a spinner + label, closer to
 *  the reply-is-coming indicator on Claude.ai/ChatGPT. */
function ThinkingDots() {
  return (
    <span className="flex items-center gap-1 py-1" aria-label="Thinking">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60"
          style={{ animationDelay: `${i * 120}ms` }}
        />
      ))}
    </span>
  );
}

/**
 * Billing Agent page — two tabs sharing one header: "Chat" (a real Claude
 * Managed Agent; conversation memory lives server-side in the agent's own
 * session, the client only ever sends the latest message) and
 * "Recommendations" (the autonomous AI recommendations panel — generated in
 * the background, not part of the chat conversation). Moved here from the
 * Overview dashboard, which is chart-first and didn't fit a text-heavy
 * recommendations list well.
 *
 * The active tab lives in the URL (`?tab=`), same convention as the
 * Settings page, so a refresh/bookmark keeps you on the same tab. Wrapped
 * in Suspense because the inner component reads `useSearchParams()`.
 */
export function AgentView() {
  return (
    <React.Suspense
      fallback={
        <div className="flex h-[calc(100svh-3.5rem)] items-center justify-center">
          <LoadingSpinner label="Loading…" />
        </div>
      }
    >
      <AgentViewInner />
    </React.Suspense>
  );
}

function AgentViewInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const tabParam = searchParams.get("tab");
  const activeTab: TabKey = (TAB_KEYS.includes(tabParam ?? "") ? tabParam : "chat") as TabKey;

  const handleTabChange = (key: TabKey) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", key);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const { messages } = React.useSyncExternalStore(
    agentChatStore.subscribe,
    agentChatStore.getSnapshot,
    agentChatStore.getServerSnapshot
  );
  const [input, setInput] = React.useState("");
  const [sending, setSending] = React.useState(false);
  // Synchronous twin of `sending`: state updates only land on the next
  // render, so a fast double Enter/click could otherwise send twice.
  const sendingRef = React.useRef(false);
  const [error, setError] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // "Discuss with Agent" on a recommendation row — switches to the Chat tab
  // and drops a ready-to-send prompt into the input so the Agent (now armed
  // with search/propose-action tools) can actually help resolve it, instead
  // of the recommendation staying a static line item.
  const handleDiscussRecommendation = (rec: Recommendation) => {
    const prefill = `Help me with this recommendation: "${rec.title}" — ${rec.detail}${
      rec.suggestedAction ? ` Suggested action: ${rec.suggestedAction}.` : ""
    }`;
    setInput(prefill);
    handleTabChange("chat");
    // The textarea only exists once the Chat tab's DOM mounts, which happens
    // on the render after handleTabChange's URL update — defer the focus.
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  // Credit balance — refetched after every turn (consumption is only known
  // server-side, after the turn completes) via a reload-key bump rather than
  // computed locally, so it never drifts from the real ledger. Seeded from
  // the shared page-data-cache so the pill shows a real number immediately
  // on mount instead of popping in a beat after every visit.
  const cachedCredits = readPageCache<{ data: CreditsData; fetchedAt: number }>(
    CREDITS_CACHE_KEY
  );
  const [credits, setCredits] = React.useState<number | null>(
    cachedCredits?.data.balance ?? null
  );
  // Distinguishes "genuinely failed to load" (worth a small hint) from
  // "hasn't fetched yet" — both leave `credits` at null otherwise.
  const [creditsError, setCreditsError] = React.useState(false);
  const [creditsReloadKey, setCreditsReloadKey] = React.useState(0);

  React.useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const response = await getMyCredits();
        if (ignore) return;
        writePageCache(CREDITS_CACHE_KEY, { data: response.data, fetchedAt: Date.now() });
        setCredits(response.data.balance);
        setCreditsError(false);
      } catch {
        // Non-critical (chat itself still works) — but worth a small,
        // non-blocking hint rather than a fully silent, blank pill.
        if (!ignore) setCreditsError(true);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [creditsReloadKey]);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  const outOfCredits = credits !== null && credits <= 0;

  const sendText = async (raw: string) => {
    const text = raw.trim();
    if (!text || sendingRef.current || outOfCredits) return;

    agentChatStore.append({ role: "user", content: text });
    setInput("");
    setError(null);
    sendingRef.current = true;
    setSending(true);

    try {
      const response = await sendAgentMessage(text);
      agentChatStore.append(response.data.message);
    } catch (err) {
      setError(agentErrorMessage(err));
    } finally {
      sendingRef.current = false;
      setSending(false);
      setCreditsReloadKey((key) => key + 1);
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void sendText(input);
  };

  const handleTextareaKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendText(input);
    }
  };

  // ── Voice input: mic → live transcript into the input field. ──
  const {
    supported: micSupported,
    listening,
    start: startListening,
    stop: stopListening,
  } = useSpeechRecognition({
    onTranscript: (text) => setInput(text),
    onError: (message) => setError(message),
  });

  const handleMicClick = () => {
    if (listening) {
      stopListening();
      return;
    }
    setError(null);
    startListening();
  };

  // ── Voice output: read new assistant replies aloud when enabled. ──
  const { supported: ttsSupported, speaking, speak, cancel: cancelSpeech } =
    useSpeechSynthesis();
  const [voiceReplies, setVoiceReplies] = React.useState(false);
  const spokenCountRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (spokenCountRef.current === null) spokenCountRef.current = messages.length;
  }, [messages.length]);

  React.useEffect(() => {
    if (!voiceReplies || spokenCountRef.current === null) return;
    if (messages.length <= spokenCountRef.current) return;
    const latest = messages[messages.length - 1];
    spokenCountRef.current = messages.length;
    if (latest?.role === "assistant") speak(latest.content);
  }, [messages, voiceReplies, speak]);

  const toggleVoiceReplies = () => {
    setVoiceReplies((value) => {
      const next = !value;
      if (!next) cancelSpeech();
      return next;
    });
  };

  const handleConnectAction = (action: ConnectPlatformAction) => {
    const params = new URLSearchParams({
      connect: action.platform,
      source: action.source,
      label: action.displayName,
    });
    router.push(`/dashboard/platforms?${params.toString()}`);
  };

  // Confirming an update/delete action calls the SAME endpoints the Billing
  // page's own edit/delete UI uses — the agent only ever prepares these, see
  // managed-agent.service.ts's propose-only tools.
  const [confirmingIndex, setConfirmingIndex] = React.useState<number | null>(null);
  const handleConfirmAction = async (
    action: Extract<AgentAction, { type: "update_billing_status" | "delete_billing_record" }>,
    index: number
  ) => {
    setConfirmingIndex(index);
    try {
      if (action.type === "update_billing_status") {
        await updateBillingRecord(action.billingId, {
          status: action.newStatus as BillingStatus,
        });
      } else {
        await deleteBillingRecord(action.billingId);
      }
      agentChatStore.setMessageActionResult(index, "done");
    } catch (err) {
      agentChatStore.setMessageActionResult(index, "error");
      setError(err instanceof ApiError ? err.message : "Failed to apply this change.");
    } finally {
      setConfirmingIndex(null);
    }
  };

  const isEmpty = messages.length === 0;
  const isChatTab = activeTab === "chat";

  return (
    <div className="flex h-[calc(100svh-3.5rem)] flex-col bg-background">
      {/* Plain header — no banner, just what a chat page needs. */}
      <div className="flex flex-col gap-3 px-4 py-3 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Sparkles className="size-4" />
            </span>
            <div>
              <h1 className="font-heading text-base font-semibold">AI Assistant</h1>
              <p className="text-xs text-muted-foreground">
                Reads your real billing data — never guesses.
              </p>
            </div>
          </div>
          {isChatTab ? (
            <div className="flex shrink-0 items-center gap-3">
              {credits !== null ? (
                <span
                  className={cn(
                    "text-xs font-medium",
                    outOfCredits ? "text-destructive" : "text-muted-foreground"
                  )}
                >
                  {Math.max(0, credits)} credit{credits === 1 ? "" : "s"} left
                </span>
              ) : creditsError ? (
                <span
                  className="text-xs text-muted-foreground"
                  title="Couldn't load your credit balance — chatting still works."
                >
                  Credits unavailable
                </span>
              ) : null}
              {ttsSupported ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={toggleVoiceReplies}
                  aria-pressed={voiceReplies}
                  title={
                    voiceReplies
                      ? speaking
                        ? "Speaking…"
                        : "Voice replies on — click to mute"
                      : "Read replies aloud"
                  }
                >
                  {voiceReplies ? (
                    <Volume2 className={cn(speaking && "animate-pulse")} />
                  ) : (
                    <VolumeX />
                  )}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-1">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => handleTabChange(key)}
              aria-current={activeTab === key ? "page" : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                activeTab === key
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {isChatTab ? (
        <div ref={scrollRef} className="flex flex-1 flex-col overflow-y-auto">
          <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-4 sm:p-6">
            {isEmpty && !sending ? (
              <div className="m-auto flex flex-col items-center gap-4">
                <EmptyState
                  icon={Sparkles}
                  title="Ask your AI Assistant anything"
                  description="It can read your real billing and platform data, and explain how to connect new platforms — try one of these to see it in action."
                />
                <div className="flex flex-wrap justify-center gap-2">
                  {SUGGESTED_PROMPTS.map((prompt) => (
                    <Button
                      key={prompt}
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={outOfCredits}
                      onClick={() => void sendText(prompt)}
                    >
                      {prompt}
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {messages.map((message, index) =>
                  message.role === "user" ? (
                    <div key={`${index}-user`} className="flex justify-end">
                      <div className="max-w-[85%] rounded-2xl bg-secondary px-4 py-2.5 text-sm text-secondary-foreground">
                        {message.content}
                      </div>
                    </div>
                  ) : (
                    <div key={`${index}-assistant`} className="flex gap-3">
                      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <Sparkles className="size-3.5" />
                      </span>
                      <div className="min-w-0 flex-1 space-y-3">
                        <MarkdownMessage content={message.content} className="text-foreground" />
                        {message.action?.type === "connect_platform" ? (
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => handleConnectAction(message.action as ConnectPlatformAction)}
                          >
                            <Plug />
                            Connect {message.action.displayName} now
                          </Button>
                        ) : null}
                        {message.action?.type === "update_billing_status" ? (
                          message.actionResult === "done" ? (
                            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                              <Check className="size-4 text-primary" />
                              Marked {message.action.invoiceNumber} as {message.action.newStatus}
                            </span>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={confirmingIndex === index}
                              onClick={() =>
                                void handleConfirmAction(
                                  message.action as Extract<
                                    AgentAction,
                                    { type: "update_billing_status" }
                                  >,
                                  index
                                )
                              }
                            >
                              {confirmingIndex === index ? (
                                <Loader2 className="animate-spin" />
                              ) : (
                                <Check />
                              )}
                              Confirm: mark {message.action.invoiceNumber} as {message.action.newStatus}
                            </Button>
                          )
                        ) : null}
                        {message.action?.type === "delete_billing_record" ? (
                          message.actionResult === "done" ? (
                            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                              <Check className="size-4 text-primary" />
                              Deleted invoice {message.action.invoiceNumber}
                            </span>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant="destructive"
                              disabled={confirmingIndex === index}
                              onClick={() =>
                                void handleConfirmAction(
                                  message.action as Extract<
                                    AgentAction,
                                    { type: "delete_billing_record" }
                                  >,
                                  index
                                )
                              }
                            >
                              {confirmingIndex === index ? (
                                <Loader2 className="animate-spin" />
                              ) : (
                                <Trash2 />
                              )}
                              Confirm: delete invoice {message.action.invoiceNumber}
                            </Button>
                          )
                        ) : null}
                        {message.actionResult === "error" ? (
                          <span className="flex items-center gap-1.5 text-sm text-destructive">
                            <CircleAlert className="size-4" />
                            That didn&apos;t go through — try again.
                          </span>
                        ) : null}
                      </div>
                    </div>
                  )
                )}
                {sending ? (
                  <div className="flex gap-3">
                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <Sparkles className="size-3.5" />
                    </span>
                    <ThinkingDots />
                  </div>
                ) : null}
              </>
            )}
          </div>

          <div className="bg-background p-4">
            <div className="mx-auto w-full max-w-2xl">
              {error ? <FormAlert variant="error" message={error} className="mb-3" /> : null}
              {outOfCredits ? (
                <FormAlert
                  variant="error"
                  message="You've used all your credits. Add more credits to keep chatting with the Billing Advisor."
                  className="mb-3"
                />
              ) : null}
              <form
                onSubmit={handleSubmit}
                className="flex items-end gap-2 rounded-2xl border bg-background p-2 pl-3 shadow-sm focus-within:ring-2 focus-within:ring-ring/50"
              >
                <Textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={handleTextareaKeyDown}
                  placeholder={listening ? "Listening…" : "Ask your agent…"}
                  disabled={sending || outOfCredits}
                  aria-label="Message"
                  rows={1}
                  className="max-h-40 min-h-9 resize-none border-none bg-transparent p-0 shadow-none focus-visible:ring-0"
                />
                <div className="flex shrink-0 items-center gap-1">
                  {micSupported ? (
                    <Button
                      type="button"
                      variant={listening ? "destructive" : "ghost"}
                      size="icon"
                      onClick={handleMicClick}
                      disabled={sending || outOfCredits}
                      aria-pressed={listening}
                      aria-label={listening ? "Stop voice input" : "Start voice input"}
                      title={listening ? "Stop voice input" : "Speak your message"}
                    >
                      {listening ? <Square className="animate-pulse" /> : <Mic />}
                    </Button>
                  ) : null}
                  <Button
                    type="submit"
                    size="icon"
                    disabled={sending || outOfCredits || !input.trim()}
                    aria-label="Send message"
                  >
                    <ArrowUp />
                  </Button>
                </div>
              </form>
              <p className="mt-2 text-center text-xs text-muted-foreground">
                Enter to send, Shift+Enter for a new line.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
            <AiRecommendations onDiscuss={handleDiscussRecommendation} />
          </div>
        </div>
      )}
    </div>
  );
}
