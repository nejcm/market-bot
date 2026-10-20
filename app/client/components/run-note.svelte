<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { RUN_NOTE_MAX_LENGTH, type StarKind } from "../../types";
  import { fetchNote, saveNote } from "../api";

  let { kind, noteKey }: { readonly kind: StarKind; readonly noteKey: string } = $props();
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

  onMount(() => {
    void load();
    return () => { active = false; };
  });
</script>

<details class="mt-3 rounded-md border border-border bg-card px-3 py-2" data-screen-label="Run Note">
  <summary class="cursor-pointer text-xs font-medium">Run Note{notice !== "" ? " — error" : ""}</summary>
  <p class="mt-2 text-xs text-muted-foreground">
    Plain text, saved only in this Console. Excluded from Run Chat, prompts, exports and history search.
    Saving empty text deletes the note. Save before leaving this page.
  </p>
  {#if loading}
    <p class="mt-2 text-xs" role="status">Loading note...</p>
  {:else if loaded}
    <label class="mt-2 block text-xs">
      {kind === "instrument" ? "Instrument note" : "Run note"}
      <textarea
        class="mt-1 block min-h-24 w-full resize-y rounded-md border border-input bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        bind:value={body}
        maxlength={RUN_NOTE_MAX_LENGTH}
        disabled={saving}
        oninput={() => { status = ""; }}
      ></textarea>
    </label>
    <div class="mt-2 flex items-center gap-3">
      <Button size="sm" disabled={saving || body === savedBody} onclick={() => void save()}>
        {saving ? "Saving..." : "Save note"}
      </Button>
      <span class="text-xs text-muted-foreground">{body.length} / {RUN_NOTE_MAX_LENGTH}</span>
    </div>
  {/if}
  {#if notice !== ""}
    <p class="mt-2 text-xs text-destructive" role="alert">Run Note: {notice}</p>
    {#if !loaded && !loading}
      <Button size="sm" variant="outline" onclick={() => void load()}>Retry note</Button>
    {/if}
  {/if}
  <p class="mt-1 text-xs text-muted-foreground" role="status">{status}</p>
</details>
