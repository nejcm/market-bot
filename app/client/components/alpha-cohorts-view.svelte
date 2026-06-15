<script lang="ts">
  import type { AlphaCohortDetail } from "../../types";
  import {
    alphaCohortHeadline,
    alphaRejectionBucketRows,
    alphaStaleLeadRows,
    formatDateMinute,
  } from "../view-model";
  import type { View } from "./console-types";

  interface Props {
    readonly detail: AlphaCohortDetail;
    readonly onNavigate: (view: View) => void;
  }

  let { detail, onNavigate }: Props = $props();

  const headline = $derived(alphaCohortHeadline(detail));
  const rejectionRows = $derived(alphaRejectionBucketRows(detail));
  const staleRows = $derived(alphaStaleLeadRows(detail));
  const hasSummary = $derived(detail.summary !== undefined);
</script>

<div class="mx-auto max-w-230" data-screen-label="Alpha cohorts">
  <h1 class="text-xl font-semibold tracking-tight">Alpha Lead Cohorts</h1>
  <div class="mt-1 text-[12.5px] text-[#5c6066]">
    Historical lead validation by rejection bucket and unbriefed lead age. Research state only, not
    promotion or trading guidance.
  </div>

  {#if !hasSummary}
    <div
      class="mt-5 rounded-lg border border-dashed border-input p-9 text-center text-sm text-muted-foreground"
    >
      No alpha cohort summary yet.
      <button
        class="text-[#166e7d] underline underline-offset-2 transition hover:text-[#0e4954] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        type="button"
        onclick={() => onNavigate("jobs")}
      >
        Queue a score job
      </button>
      to rebuild alpha validation artifacts.
    </div>
  {:else}
    <div class="mt-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
      {#each [
        { value: headline.rejectedCandidateCount, label: "Rejected candidates" },
        { value: headline.watchlistCandidateCount, label: "Watchlist leads" },
        { value: headline.tickerBriefedLeadCount, label: "Ticker briefed" },
        { value: headline.unbriefedLeadCount, label: "Unbriefed leads" },
      ] as card}
        <div class="rounded-lg border border-border bg-card px-4 py-3.5">
          <div class="font-mono text-2xl font-medium text-foreground">{card.value}</div>
          <div class="mt-1 text-[11px] uppercase tracking-wider text-muted-foreground">
            {card.label}
          </div>
        </div>
      {/each}
    </div>

    <div class="mt-3.5 text-right font-mono text-[10.5px] text-muted-foreground">
      {formatDateMinute(headline.generatedAt)}
    </div>

    <div class="mt-3.5 overflow-hidden rounded-lg border border-border bg-card">
      <div
        class="grid grid-cols-[minmax(0,1fr)_72px_72px_84px_minmax(0,1.2fr)] gap-3 border-b border-border bg-secondary px-4.5 py-2.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground"
      >
        <div>Reason</div>
        <div class="text-right">Rejected</div>
        <div class="text-right">Symbols</div>
        <div class="text-right">Validated</div>
        <div>Validation</div>
      </div>
      {#if rejectionRows.length === 0}
        <div class="px-4.5 py-3 text-[12.5px] text-muted-foreground">
          No rejected candidates captured yet.
        </div>
      {:else}
        {#each rejectionRows as row}
          <div
            class="grid grid-cols-[minmax(0,1fr)_72px_72px_84px_minmax(0,1.2fr)] items-center gap-3 border-b border-[#f0ede7] px-4.5 py-2.75 last:border-b-0"
          >
            <div class="truncate text-[12.5px] font-medium">{row.reason}</div>
            <div class="text-right font-mono text-[11.5px] text-[#5c6066]">
              {row.rejectedCount}
            </div>
            <div class="text-right font-mono text-[11.5px] text-[#5c6066]">
              {row.uniqueSymbolCount}
            </div>
            <div class="text-right font-mono text-[11.5px] text-[#5c6066]">
              {row.laterValidatedSymbolCount}
            </div>
            <div class="truncate font-mono text-[10.5px] text-[#5c6066]">{row.validation}</div>
          </div>
        {/each}
      {/if}
    </div>

    <div class="mt-3.5 overflow-hidden rounded-lg border border-border bg-card">
      <div
        class="grid grid-cols-[120px_120px_minmax(0,1fr)] gap-3 border-b border-border bg-secondary px-4.5 py-2.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground"
      >
        <div>Age bucket</div>
        <div class="text-right">Unbriefed</div>
        <div>Validation</div>
      </div>
      {#if staleRows.length === 0}
        <div class="px-4.5 py-3 text-[12.5px] text-muted-foreground">
          No unbriefed lead cohorts yet.
        </div>
      {:else}
        {#each staleRows as row}
          <div
            class="grid grid-cols-[120px_120px_minmax(0,1fr)] items-center gap-3 border-b border-[#f0ede7] px-4.5 py-2.75 last:border-b-0"
          >
            <div class="font-mono text-[11.5px] text-[#45494e]">{row.ageBucket}</div>
            <div class="text-right font-mono text-[11.5px] text-[#5c6066]">
              {row.unbriefedLeadCount}
            </div>
            <div class="truncate font-mono text-[10.5px] text-[#5c6066]">{row.validation}</div>
          </div>
        {/each}
      {/if}
    </div>
  {/if}

  {#if detail.markdown !== undefined}
    <div class="mt-3.5 overflow-x-auto rounded-lg bg-[#16181a] px-5 py-4.5">
      <pre class="font-mono text-xs leading-relaxed text-[#c7cdd4]">{detail.markdown}</pre>
    </div>
  {/if}
</div>
