<script lang="ts">
  import type { RunSummary } from "../../types";
  import {
    formatDateMinute,
    instrumentPath,
    instrumentRunHistory,
    instrumentRunHistoryFor,
  } from "../view-model";

  interface Props {
    readonly runs: readonly RunSummary[];
    readonly assetClass: string;
    readonly symbol: string;
    readonly currentRunId?: string | undefined;
    readonly onOpenRun: (runId: string) => void;
    readonly onOpenInstrument?: ((assetClass: string, symbol: string) => void) | undefined;
  }

  let { runs, assetClass, symbol, currentRunId, onOpenRun, onOpenInstrument }: Props = $props();

  const instrumentAssetClass = $derived(assetClass.trim());
  const instrumentSymbol = $derived(symbol.trim().toUpperCase());
  const historyRuns = $derived(
    instrumentRunHistoryFor(instrumentRunHistory(runs), instrumentAssetClass, instrumentSymbol),
  );
</script>

<section class="mt-5 overflow-hidden rounded-lg border border-border bg-card" data-screen-label="Instrument run history">
  <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1.5 px-4.5 pb-3 pt-4">
    <h2 class="text-sm font-semibold">Instrument run history</h2>
    <div class="flex items-baseline gap-2.5">
      {#if onOpenInstrument !== undefined}
        <a
          class="rounded border border-[#cfe0e3] bg-accent px-1.75 py-0.5 font-mono text-[10px] text-primary transition hover:border-[#9fc2c8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          href={instrumentPath(instrumentAssetClass, instrumentSymbol)}
          onclick={(event) => {
            if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
              return;
            }
            event.preventDefault();
            onOpenInstrument(instrumentAssetClass, instrumentSymbol);
          }}
        >
          {instrumentAssetClass}:{instrumentSymbol}
        </a>
      {/if}
      <span class="font-mono text-[10.5px] text-muted-foreground">
        {historyRuns.length} {historyRuns.length === 1 ? "run" : "runs"} · newest first
      </span>
    </div>
  </div>

  {#if historyRuns.length === 0}
    <div class="px-4.5 pb-5 pt-1 text-sm text-muted-foreground">
      No runs recorded for this instrument.
    </div>
  {:else}
    <div class="sm:overflow-x-auto">
      <div class="sm:min-w-170">
        <div
          class="hidden sm:grid grid-cols-[minmax(150px,1fr)_58px_80px_50px_50px_50px_50px_64px] gap-3 border-y border-border bg-secondary px-4.5 py-2.5 font-mono text-[10px] tracking-[0.08em] text-muted-foreground"
        >
          <div>DATE</div>
          <div>DEPTH</div>
          <div>CONFIDENCE</div>
          <div class="text-right">FND</div>
          <div class="text-right">FCT</div>
          <div class="text-right">SRC</div>
          <div class="text-right">GAP</div>
          <div>SCORED</div>
        </div>
        {#each historyRuns as run (run.runId)}
          {@const current = run.runId === currentRunId}
          <button
            class="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(150px,1fr)_58px_80px_50px_50px_50px_50px_64px] border-b border-[#f0ede7] px-4.5 py-2.25 text-left transition last:border-b-0 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {current
              ? 'bg-accent'
              : 'bg-transparent'}"
            type="button"
            aria-current={current ? "true" : undefined}
            onclick={() => onOpenRun(run.runId)}
          >
            <span
              class="truncate font-mono text-[11.5px] {current
                ? 'font-semibold text-primary'
                : 'text-[#5c6066]'}"
              title={run.runId}
            >
              {formatDateMinute(run.generatedAt)}
            </span>
            <span class="flex items-center gap-1 sm:hidden">
              {#if run.depth !== undefined}
                <span
                  class="rounded border border-border bg-secondary px-1.75 py-0.5 font-mono text-[10px] text-[#5c6066]"
                  >{run.depth}</span
                >
              {/if}
              {#if run.hasScore}
                <span
                  class="rounded border border-[#9fc2c8] bg-[#e7f1f3] px-1.75 py-0.5 font-mono text-[10px] text-[#166e7d]"
                  >scored</span
                >
              {/if}
            </span>
            <span class="col-span-2 font-mono text-[10.5px] text-[#8a8f96] sm:hidden">
              {run.confidence ?? "—"} · {run.findingCount} fnd · {run.predictionCount} fct · {run.sourceCount} src
              · {run.dataGapCount} gap
            </span>
            <span class="hidden sm:contents">
            <span>
              {#if run.depth !== undefined}
                <span
                  class="rounded border border-border bg-secondary px-1.75 py-0.5 font-mono text-[10px] text-[#5c6066]"
                >
                  {run.depth}
                </span>
              {/if}
            </span>
            <span class="truncate font-mono text-[11.5px] text-[#5c6066]">
              {run.confidence ?? "—"}
            </span>
            <span class="text-right font-mono text-[11.5px] text-[#5c6066]">{run.findingCount}</span>
            <span class="text-right font-mono text-[11.5px] text-[#5c6066]">
              {run.predictionCount}
            </span>
            <span class="text-right font-mono text-[11.5px] text-[#5c6066]">{run.sourceCount}</span>
            <span class="text-right font-mono text-[11.5px] text-[#5c6066]">{run.dataGapCount}</span>
            <span>
              {#if run.hasScore}
                <span
                  class="rounded border border-[#9fc2c8] bg-[#e7f1f3] px-1.75 py-0.5 font-mono text-[10px] text-[#166e7d]"
                >
                  scored
                </span>
              {/if}
            </span>
            </span>
          </button>
        {/each}
      </div>
    </div>
  {/if}
</section>
