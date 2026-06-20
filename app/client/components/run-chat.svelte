<script lang="ts">
  import { Chat } from "@ai-sdk/svelte";
  import { TextStreamChatTransport } from "ai";
  import MessageSquareIcon from "@lucide/svelte/icons/message-square";
  import SendHorizontalIcon from "@lucide/svelte/icons/send-horizontal";
  import LoaderIcon from "@lucide/svelte/icons/loader";
  import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetDescription,
  } from "$lib/components/ui/sheet";
  import { Button } from "$lib/components/ui/button";

  interface Props {
    readonly runId: string;
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
  }

  let { runId, open, onOpenChange }: Props = $props();

  let inputText = $state("");
  let messagesEndEl: HTMLElement | undefined = $state();

  function createChat(id: string): Chat {
    return new Chat({
      transport: new TextStreamChatTransport({
        api: `/api/runs/${encodeURIComponent(id)}/chat`,
      }),
    });
  }

  let chat = $state(createChat(runId));
  let trackedRunId = runId;

  $effect(() => {
    if (runId !== trackedRunId) {
      trackedRunId = runId;
      chat = createChat(runId);
      inputText = "";
    }
  });

  $effect(() => {
    void chat.messages.length;
    messagesEndEl?.scrollIntoView({ behavior: "smooth" });
  });

  const isBusy = $derived(
    chat.status === "submitted" || chat.status === "streaming",
  );

  function textFromParts(parts: readonly unknown[]): string {
    return parts
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          (part as Record<string, unknown>).type === "text" &&
          "text" in part &&
          typeof (part as Record<string, unknown>).text === "string",
      )
      .map((part) => part.text)
      .join("");
  }

  async function handleSend(): Promise<void> {
    const text = inputText.trim();
    if (text === "" || isBusy) {
      return;
    }
    inputText = "";
    await chat.sendMessage({ text });
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  }
</script>

<Sheet {open} {onOpenChange}>
  <SheetContent side="right" class="data-[side=right]:sm:max-w-md">
    <SheetHeader>
      <SheetTitle>
        <span class="flex items-center gap-2 text-sm">
          <MessageSquareIcon class="h-4 w-4" />
          Run chat
        </span>
      </SheetTitle>
      <SheetDescription class="text-xs">
        Ask questions grounded in this run's artifacts
      </SheetDescription>
    </SheetHeader>

    <div class="flex min-h-0 flex-1 flex-col overflow-y-auto px-4">
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
          <div
            class="mb-3 {message.role === 'user'
              ? 'ml-8 rounded-lg bg-primary px-3.5 py-2.5 text-primary-foreground'
              : 'mr-8 rounded-lg border border-border bg-card px-3.5 py-2.5'}"
          >
            <div
              class="mb-1 text-[10px] font-semibold uppercase tracking-wider opacity-60"
            >
              {message.role === "user" ? "You" : "Assistant"}
            </div>
            <div class="whitespace-pre-wrap text-[13px] leading-relaxed">
              {textFromParts(message.parts)}
            </div>
          </div>
        {/if}
      {/each}

      {#if isBusy && (chat.messages.length === 0 || chat.messages[chat.messages.length - 1]?.role === "user")}
        <div
          class="mb-3 mr-8 flex items-center gap-2 rounded-lg border border-border bg-card px-3.5 py-2.5"
        >
          <LoaderIcon
            class="h-3.5 w-3.5 animate-spin text-muted-foreground"
          />
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

    <div class="border-t border-border px-4 pt-3">
      <div class="flex gap-2">
        <textarea
          class="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="Ask about this run…"
          aria-label="Chat message"
          rows={2}
          bind:value={inputText}
          onkeydown={handleKeyDown}
          disabled={isBusy}
        ></textarea>
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
  </SheetContent>
</Sheet>
