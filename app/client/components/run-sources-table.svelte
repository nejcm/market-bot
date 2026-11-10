<script lang="ts">
  import type { SourceView } from "../../report-artifact-view";

  interface Props {
    readonly sourceItems: readonly SourceView[];
    readonly highlightSourceId: string;
  }

  let { sourceItems, highlightSourceId }: Props = $props();
</script>

<div class="mt-6 overflow-hidden rounded-lg border border-border bg-card" data-section="sourcesTable">
  <div class="sm:overflow-x-auto">
    <div class="sm:min-w-160">
      <div
        class="hidden sm:grid grid-cols-[170px_minmax(0,1fr)_140px_130px_70px] gap-3.5 border-b border-border bg-secondary px-4.5 py-2.5 font-mono text-[10px] tracking-[0.08em] text-muted-foreground"
      >
        <div>ID</div>
        <div>TITLE</div>
        <div>KIND</div>
        <div>PROVIDER</div>
        <div>LINK</div>
      </div>
      {#if sourceItems.length === 0}
        <div class="px-4.5 py-6 text-sm text-muted-foreground">This run cites no normalized sources.</div>
      {/if}
      {#each sourceItems as source}
        <div
          {@attach (el) => {
            if (highlightSourceId === source.id) {
              el.scrollIntoView({ block: "center" });
            }
          }}
          class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-1 border-b sm:grid-cols-[170px_minmax(0,1fr)_140px_130px_70px] sm:gap-y-0 border-[#f0ede7] px-4.5 py-2.75 {highlightSourceId ===
          source.id
            ? 'bg-accent'
            : 'bg-transparent'}"
        >
          <div class="truncate font-mono text-[11.5px] font-medium text-primary" title={source.id}>
            {source.id}
          </div>
          <div class="order-3 col-span-2 truncate text-[12.5px] text-[#1f2225] sm:order-none sm:col-span-1" title={source.title}>
            {source.title}
          </div>
          <div class="order-2 sm:order-none">
            <span
              class="whitespace-nowrap rounded border border-border bg-secondary px-1.75 py-0.5 font-mono text-[10px] text-[#5c6066]"
            >
              {source.kind ?? "source"}
            </span>
          </div>
          <div class="order-4 truncate text-xs text-[#5c6066] sm:order-none">
            {source.provider ?? ""}
          </div>
          <div class="order-5 text-right sm:order-none sm:text-left">
            {#if source.url !== undefined}
              <a
                class="font-mono text-[11px] text-primary hover:underline"
                href={source.url}
                target="_blank"
                rel="noreferrer"
              >
                open ↗
              </a>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  </div>
</div>
