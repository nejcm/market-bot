<script lang="ts">
  import { onMount } from "svelte";
  import StickyNote from "@lucide/svelte/icons/sticky-note";
  import { Popover } from "bits-ui";
  import { Button } from "$lib/components/ui/button";
  import { RUN_NOTE_MAX_LENGTH, type NoteKind } from "../../types";
  import { fetchNote, saveNote } from "../api";
  import { noteIndicator } from "../view-model";

  interface Props {
    readonly kind: NoteKind;
    readonly noteKey: string;
    readonly size?: "default" | "header";
  }

  let { kind, noteKey, size = "default" }: Props = $props();
  let body = $state("");
  let savedBody = $state("");
  let loading = $state(true);
  let loaded = $state(false);
  let saving = $state(false);
  let notice = $state("");
  let status = $state("");
  let active = true;

  async function load(): Promise<void> {
    loading = true;
    notice = "";
    try {
      const note = await fetchNote(kind, noteKey);
      if (active) {
        body = note?.body ?? "";
        savedBody = body;
        loaded = true;
      }
    } catch (error: unknown) {
      if (active) {
        notice = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (active) {
        loading = false;
      }
    }
  }

  async function save(): Promise<void> {
    saving = true;
    notice = "";
    status = "";
    try {
      const note = await saveNote(kind, noteKey, body);
      if (active) {
        savedBody = note?.body ?? "";
        status = note === null ? "Note deleted." : "Note saved.";
      }
    } catch (error: unknown) {
      if (active) {
        notice = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (active) {
        saving = false;
      }
    }
  }

  const label = $derived(kind === "instrument" ? "Instrument note" : "Run note");
  const noteState = $derived(noteIndicator(notice, body, savedBody));
  const STATE_LABELS = { error: " (error)", unsaved: " (unsaved draft)", saved: " (has note)", empty: "" };
  const DOT_CLASSES = { error: "bg-destructive", unsaved: "bg-[#c9a24b]", saved: "bg-primary", empty: "" };

  onMount(() => {
    void load();
    return () => { active = false; };
  });
</script>

<Popover.Root>
  <Popover.Trigger
    class="relative flex shrink-0 items-center gap-1.5 border bg-secondary font-mono text-[10.5px] transition hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {size ===
    'header'
      ? 'h-8.75 min-w-8.75 justify-center rounded-full border-border px-2.5 text-muted-foreground'
      : 'h-8 rounded-md border-input px-2.5'}"
    aria-label="{label}{STATE_LABELS[noteState]}"
    data-screen-label="Run Note"
  >
    <StickyNote class={size === "header" ? "size-4" : "size-3.5"} />
    <span class={size === "header" ? "hidden sm:inline" : ""}>Note</span>
    {#if noteState !== "empty"}
      <span class="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-background {DOT_CLASSES[noteState]}"></span>
    {/if}
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content
      align="end"
      sideOffset={6}
      collisionPadding={16}
      onOpenAutoFocus={(event) => {
        if (matchMedia("(pointer: coarse)").matches) {
          event.preventDefault();
        }
      }}
      class="z-50 w-[min(24rem,calc(100vw-2rem))] rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-md"
    >
      <div class="font-mono text-[10px] tracking-widest text-muted-foreground">{label.toUpperCase()}</div>
      <p class="mt-1.5 text-xs text-muted-foreground">
        Plain text, saved only in this Console. Excluded from Run Chat, prompts, exports and history search.
        Saving empty text deletes the note. Closing keeps a draft; save before leaving this page.
      </p>
      {#if loading}
        <p class="mt-2 text-xs" role="status">Loading note...</p>
      {:else if loaded}
        <textarea
          class="mt-2 block min-h-32 w-full resize-y rounded-md border border-input bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={label}
          bind:value={body}
          maxlength={RUN_NOTE_MAX_LENGTH}
          disabled={saving}
          oninput={() => { status = ""; }}
        ></textarea>
        <div class="mt-2 flex items-center gap-3">
          <Button size="sm" disabled={saving || body === savedBody} onclick={() => void save()}>
            {saving ? "Saving..." : "Save note"}
          </Button>
          <span class="text-xs text-muted-foreground">{body.length} / {RUN_NOTE_MAX_LENGTH}</span>
        </div>
      {/if}
      {#if notice !== ""}
        <p class="mt-2 text-xs text-destructive" role="alert">{label}: {notice}</p>
        {#if !loaded && !loading}
          <Button size="sm" variant="outline" onclick={() => void load()}>Retry note</Button>
        {/if}
      {/if}
      <p class="mt-1 text-xs text-muted-foreground" role="status">{status}</p>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
