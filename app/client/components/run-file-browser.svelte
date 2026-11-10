<script lang="ts">
  import type { RunDetail } from "../../types";

  interface Props {
    readonly detail: RunDetail;
    readonly selectedFile: string;
    readonly fileContent: string;
    readonly onLoadFile: (path: string) => void;
  }

  let { detail, selectedFile, fileContent, onLoadFile }: Props = $props();
</script>

<div class="mt-6 grid items-start gap-3.5 lg:grid-cols-[250px_minmax(0,1fr)]" data-section="fileBrowser">
  <div class="overflow-hidden rounded-lg border border-border bg-card">
    {#if detail.summary.availableFiles.length === 0}
      <div class="px-3.5 py-5 text-sm text-muted-foreground">No files on disk.</div>
    {/if}
    {#each detail.summary.availableFiles as file}
      <button
        class="block w-full border-b border-[#f0ede7] px-3.5 py-2.25 text-left transition last:border-b-0 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {selectedFile ===
        file
          ? 'bg-accent'
          : 'bg-transparent'}"
        type="button"
        onclick={() => onLoadFile(file)}
      >
        <span
          class="block truncate font-mono text-[11.5px] {selectedFile === file
            ? 'text-primary'
            : 'text-[#45494e]'}"
        >
          {file}
        </span>
      </button>
    {/each}
  </div>
  {#if selectedFile === ""}
    <div
      class="flex min-h-80 items-center justify-center rounded-lg border border-dashed border-input text-[13px] text-muted-foreground"
    >
      Select a file to view its contents
    </div>
  {:else}
    <div class="min-h-80 max-h-[75vh] overflow-auto rounded-lg bg-[#16181a] px-5 py-4.5">
      <div class="mb-3 font-mono text-[10.5px] text-[#6e757d]">
        runs/{detail.summary.runId}/{selectedFile}
      </div>
      <pre class="font-mono text-xs leading-relaxed text-[#c7cdd4]">{fileContent}</pre>
    </div>
  {/if}
</div>
