<script lang="ts">
  import { Chat } from "@ai-sdk/svelte";
  import { TextStreamChatTransport } from "ai";
  import CheckIcon from "@lucide/svelte/icons/check";
  import CopyIcon from "@lucide/svelte/icons/copy";
  import MessageSquareIcon from "@lucide/svelte/icons/message-square";
  import SendHorizontalIcon from "@lucide/svelte/icons/send-horizontal";
  import LoaderIcon from "@lucide/svelte/icons/loader";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import { Button } from "$lib/components/ui/button";
  import {
    loadRunChatMessages,
    saveRunChatMessages,
    stampRunChatMessages,
  } from "./run-chat-storage";
  import { renderMarkdown } from "./markdown";
  import {
    formatChatTimestamp,
    messageCreatedAt,
    textFromParts,
  } from "./run-chat-message-utils";

  interface Props {
    readonly runId: string;
  }

  let { runId }: Props = $props();

  let inputText = $state("");
  let messagesEndEl: HTMLElement | undefined = $state();
  let copyFeedback:
    | { readonly messageId: string; readonly status: "copied" | "failed" }
    | undefined = $state();
  let copyFeedbackTimer: ReturnType<typeof setTimeout> | null = null;

  function createChat(id: string): Chat {
    return new Chat({
      messages: loadRunChatMessages(id),
      transport: new TextStreamChatTransport({
        api: `/api/runs/${encodeURIComponent(id)}/chat`,
      }),
    });
  }

  function initialRunId(): string {
    return runId;
  }

  let chat = $state(createChat(initialRunId()));
  let trackedRunId = initialRunId();

  $effect(() => {
    if (runId !== trackedRunId) {
      trackedRunId = runId;
      chat = createChat(runId);
      inputText = "";
      clearCopyFeedback();
    }
  });

  $effect(() => {
    void chat.messages.length;
    messagesEndEl?.scrollIntoView({ behavior: "smooth" });
  });

  // Persist completed turns per run, guarded on a settled status.
  // This keeps partial streaming chunks out of storage across reloads.
  $effect(() => {
    const { status, messages } = chat;
    void messages.length;
    if (status === "ready" || status === "error") {
      const stampedMessages = stampRunChatMessages(messages, Date.now());
      if (stampedMessages !== messages) {
        chat.messages = stampedMessages;
      }
      saveRunChatMessages(trackedRunId, stampedMessages);
    }
  });

  $effect(() => () => {
    clearCopyFeedback();
  });

  const isBusy = $derived(
    chat.status === "submitted" || chat.status === "streaming",
  );

  function clearCopyFeedback(): void {
    if (copyFeedbackTimer !== null) {
      clearTimeout(copyFeedbackTimer);
      copyFeedbackTimer = null;
    }
    copyFeedback = undefined;
  }

  function showCopyFeedback(messageId: string, status: "copied" | "failed"): void {
    clearCopyFeedback();
    copyFeedback = { messageId, status };
    copyFeedbackTimer = setTimeout(() => {
      copyFeedback = undefined;
      copyFeedbackTimer = null;
    }, 1600);
  }

  async function handleCopy(messageId: string, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      showCopyFeedback(messageId, "copied");
    } catch {
      showCopyFeedback(messageId, "failed");
    }
  }

  function handleClearChat(): void {
    if (
      chat.messages.length === 0 ||
      !confirm("Clear the chat transcript for this run?")
    ) {
      return;
    }
    saveRunChatMessages(trackedRunId, []);
    chat = createChat(trackedRunId);
    inputText = "";
    clearCopyFeedback();
  }

  async function handleSend(): Promise<void> {
    const text = inputText.trim();
    if (text === "" || isBusy) {
      return;
    }
    inputText = "";
    await chat.sendMessage({ text, metadata: { createdAt: Date.now() } });
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  }
</script>

<div
  class="mt-6 flex flex-col overflow-hidden rounded-lg border border-border bg-card"
>
  <div class="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
    <div class="flex items-center gap-2">
      <MessageSquareIcon class="h-4 w-4 text-muted-foreground" />
      <div>
        <div class="text-sm font-semibold">Run chat</div>
        <div class="text-xs text-muted-foreground">
          Ask questions grounded in this run's artifacts
        </div>
      </div>
    </div>
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Clear run chat"
      title="Clear run chat"
      onclick={handleClearChat}
      disabled={isBusy || chat.messages.length === 0}
    >
      <Trash2Icon class="h-3.5 w-3.5" />
    </Button>
  </div>

  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4">
    <div class="sr-only" aria-live="polite" role="status">
      {copyFeedback?.status === "copied"
        ? "Message copied"
        : copyFeedback?.status === "failed"
          ? "Copy failed"
          : ""}
    </div>

    {#if chat.messages.length === 0}
      <div class="flex flex-1 items-center justify-center text-center">
        <div class="text-sm text-muted-foreground">
          <p>Ask anything about this research run.</p>
          <p class="mt-1 text-xs">The model sees the full run artifacts.</p>
        </div>
      </div>
    {/if}

    {#each chat.messages as message (message.id)}
      {#if message.role === "user" || message.role === "assistant"}
        {@const messageText = textFromParts(message.parts)}
        {@const timestamp = formatChatTimestamp(messageCreatedAt(message))}
        {@const feedback = copyFeedback?.messageId === message.id
          ? copyFeedback.status
          : undefined}
        <div
          class="mb-3 rounded-lg px-3.5 py-2.5 {message.role === 'user'
            ? 'ml-auto w-auto max-w-[70%] bg-primary text-primary-foreground'
            : 'w-full border border-border bg-secondary'}"
        >
          {#if message.role === "assistant"}
            <!-- Assistant output is markdown; renderMarkdown sanitizes before {@html}. -->
            <div class="markdown-body text-[13px] leading-relaxed">
              {@html renderMarkdown(messageText)}
            </div>
          {:else}
            <div class="whitespace-pre-wrap text-[13px] leading-relaxed">
              {messageText}
            </div>
          {/if}
          <div
            class="mt-2 flex items-center justify-end gap-2 text-[11px] {message.role ===
            'user'
              ? 'text-primary-foreground/75'
              : 'text-muted-foreground'}"
          >
            {#if timestamp !== ""}
              <time datetime={new Date(messageCreatedAt(message) ?? 0).toISOString()}>
                {timestamp}
              </time>
            {/if}
            <button
              type="button"
              class="inline-flex h-5 items-center gap-1 rounded px-1.5 transition-colors {message.role ===
              'user'
                ? 'hover:bg-white/15 focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary-foreground/80'
                : 'hover:bg-background focus-visible:outline focus-visible:outline-1 focus-visible:outline-ring'}"
              aria-label={feedback === "copied"
                ? "Message copied"
                : feedback === "failed"
                  ? "Copy failed"
                  : "Copy message"}
              title={feedback === "copied"
                ? "Copied"
                : feedback === "failed"
                  ? "Copy failed"
                  : "Copy message"}
              onclick={() => void handleCopy(message.id, messageText)}
            >
              {#if feedback === "copied"}
                <CheckIcon class="h-3 w-3" />
                <span>Copied</span>
              {:else}
                <CopyIcon class="h-3 w-3" />
                <span>{feedback === "failed" ? "Failed" : "Copy"}</span>
              {/if}
            </button>
          </div>
        </div>
      {/if}
    {/each}

    {#if isBusy && (chat.messages.length === 0 || chat.messages[chat.messages.length - 1]?.role === "user")}
      <div
        class="mb-3 w-auto mr-auto flex items-center gap-2 rounded-lg border border-border bg-secondary px-3.5 py-2.5"
      >
        <LoaderIcon class="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        <span class="text-xs text-muted-foreground">Thinking…</span>
      </div>
    {/if}

    {#if chat.error !== undefined}
      <div
        class="mb-3 rounded-lg border border-[#d9c89a] bg-[#fbf6ea] px-3 py-2 text-[12px] text-[#8a6116]"
      >
        {chat.error.message}
      </div>
    {/if}

    <div bind:this={messagesEndEl}></div>
  </div>

  <div class="border-t border-border px-4 py-3">
    <div class="flex gap-2">
      <textarea
        class="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        placeholder="Ask about this run…"
        aria-label="Chat message"
        rows={2}
        bind:value={inputText}
        onkeydown={handleKeyDown}
        disabled={isBusy}></textarea>
      <Button
        class="self-end"
        size="icon"
        aria-label="Send message"
        onclick={() => void handleSend()}
        disabled={isBusy || inputText.trim() === ""}
      >
        <SendHorizontalIcon class="h-4 w-4" />
      </Button>
    </div>
  </div>
</div>

<style>
  /* Markdown rendered via {@html}; Svelte scoping needs :global to reach it. */
  .markdown-body :global(> *:first-child) {
    margin-top: 0;
  }
  .markdown-body :global(> *:last-child) {
    margin-bottom: 0;
  }
  .markdown-body :global(p),
  .markdown-body :global(ul),
  .markdown-body :global(ol),
  .markdown-body :global(blockquote),
  .markdown-body :global(pre),
  .markdown-body :global(table) {
    margin: 0.5rem 0;
  }
  .markdown-body :global(h1),
  .markdown-body :global(h2),
  .markdown-body :global(h3),
  .markdown-body :global(h4) {
    margin: 0.85rem 0 0.4rem;
    font-weight: 600;
    line-height: 1.3;
  }
  .markdown-body :global(h1) {
    font-size: 1.15rem;
  }
  .markdown-body :global(h2) {
    font-size: 1.05rem;
  }
  .markdown-body :global(h3) {
    font-size: 1rem;
  }
  .markdown-body :global(h4) {
    font-size: 0.95rem;
  }
  .markdown-body :global(ul),
  .markdown-body :global(ol) {
    padding-left: 1.35rem;
  }
  .markdown-body :global(ul) {
    list-style: disc;
  }
  .markdown-body :global(ol) {
    list-style: decimal;
  }
  .markdown-body :global(li) {
    margin: 0.2rem 0;
  }
  .markdown-body :global(li > ul),
  .markdown-body :global(li > ol) {
    margin: 0.2rem 0;
  }
  .markdown-body :global(a) {
    color: var(--primary);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .markdown-body :global(strong) {
    font-weight: 600;
  }
  .markdown-body :global(em) {
    font-style: italic;
  }
  .markdown-body :global(blockquote) {
    border-left: 2px solid var(--border);
    padding-left: 0.75rem;
    color: var(--muted-foreground);
  }
  .markdown-body :global(code) {
    border-radius: 4px;
    background: rgb(0 0 0 / 6%);
    padding: 0.1em 0.35em;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.875em;
  }
  .markdown-body :global(pre) {
    overflow-x: auto;
    border-radius: 8px;
    background: #16181a;
    padding: 0.85rem 1rem;
  }
  .markdown-body :global(pre code) {
    background: transparent;
    padding: 0;
    color: #c7cdd4;
    font-size: 0.8125rem;
    line-height: 1.5;
  }
  .markdown-body :global(table) {
    display: block;
    overflow-x: auto;
    border-collapse: collapse;
    font-size: 0.8125rem;
  }
  .markdown-body :global(th),
  .markdown-body :global(td) {
    border: 1px solid var(--border);
    padding: 0.3rem 0.55rem;
    text-align: left;
  }
  .markdown-body :global(th) {
    background: var(--secondary);
    font-weight: 600;
  }
  .markdown-body :global(hr) {
    margin: 0.85rem 0;
    border: 0;
    border-top: 1px solid var(--border);
  }
  .markdown-body :global(img) {
    max-width: 100%;
  }
</style>
