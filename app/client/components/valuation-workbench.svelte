<script lang="ts">
  import type { Snippet } from "svelte";
  import type {
    RunWorkspaceExcludedValuationPeerRow,
    RunWorkspaceValuationWorkbenchView,
    BindSection,
    RunWorkspaceSectionKey,
  } from "../run-workspace-view";

  interface Props {
    readonly workbench: RunWorkspaceValuationWorkbenchView;
    readonly excludedPeerRows: readonly RunWorkspaceExcludedValuationPeerRow[];
    readonly sectionKey: RunWorkspaceSectionKey;
    readonly citeChips: Snippet<[readonly string[]]>;
    readonly bindSection: BindSection;
  }

  let {
    workbench: valuationWorkbench,
    excludedPeerRows,
    sectionKey,
    citeChips,
    bindSection,
  }: Props = $props();
</script>

<section {@attach bindSection(sectionKey)} class="mt-8.5 scroll-mt-5">
  <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2">
    <span class="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
      Valuation workbench
    </span>
    <span class="font-mono text-[10px] text-[#8a8f96]">
      {valuationWorkbench.reportingCurrency} reporting · {valuationWorkbench.quoteCurrency} quote
    </span>
  </div>
  <div class="mt-2 text-[10px] leading-snug text-muted-foreground">
    {valuationWorkbench.priceSelectionRule}. {valuationWorkbench.trailingDisclosure}.
  </div>
  {#if valuationWorkbench.rows.length > 0}
    <div class="mt-3 overflow-x-auto rounded-lg border border-border">
      <table class="w-full min-w-[700px] border-collapse text-left">
        <thead class="bg-secondary text-[9px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th class="px-2.5 py-2 font-semibold">Basis</th>
            <th class="px-2.5 py-2 font-semibold">Period</th>
            <th class="px-2.5 py-2 font-semibold">Public</th>
            <th class="px-2.5 py-2 font-semibold">Eligible close</th>
            <th class="px-2.5 py-2 text-right font-semibold">P/E</th>
            <th class="px-2.5 py-2 text-right font-semibold">P/S</th>
            <th class="px-2.5 py-2 text-right font-semibold">EV/revenue</th>
            <th class="px-2.5 py-2 text-right font-semibold">P/FCF</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-border font-mono text-[10px]">
          {#each valuationWorkbench.rows as row}
            <tr>
              <td class="px-2.5 py-2">{row.basis}</td>
              <td class="px-2.5 py-2">{row.periodEnd}</td>
              <td class="px-2.5 py-2">{row.publicAt}</td>
              <td class="px-2.5 py-2">{row.price}</td>
              {#each [row.priceToEarnings, row.priceToSales, row.enterpriseValueToRevenue, row.priceToFreeCashFlow] as metric}
                <td
                  class="px-2.5 py-2 text-right {metric.status === 'populated'
                    ? 'text-foreground'
                    : metric.status === 'not-meaningful'
                      ? 'text-[#8a6116]'
                      : 'text-muted-foreground'}"
                  title={metric.detail}
                >
                  {metric.display}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="mt-3 rounded-lg border border-border bg-secondary px-4 py-3 text-sm text-muted-foreground">
      Historical multiples suppressed: {valuationWorkbench.suppressionReasons.join("; ") || "no compatible inputs"}.
    </div>
  {/if}
  <div class="mt-4 flex flex-wrap items-baseline justify-between gap-2">
    <div class="text-[10px] font-semibold uppercase tracking-wider text-[#5c6066]">
      Peer table
    </div>
    <div class="font-mono text-[10px] text-primary">
      supportability · {valuationWorkbench.peerSupportability}
    </div>
  </div>
  {#if valuationWorkbench.peerRows.length > 0}
    <div class="mt-2 overflow-x-auto rounded-lg border border-border">
      <table class="w-full min-w-[620px] border-collapse text-left">
        <thead class="bg-secondary text-[9px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th class="px-2.5 py-2 font-semibold">Symbol</th>
            <th class="px-2.5 py-2 font-semibold">Role</th>
            <th class="px-2.5 py-2 font-semibold">Screen</th>
            <th class="px-2.5 py-2 text-right font-semibold">EV/revenue</th>
            <th class="px-2.5 py-2 font-semibold">Currency</th>
            <th class="px-2.5 py-2 font-semibold">Input dates</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-border font-mono text-[10px]">
          {#each valuationWorkbench.peerRows as row}
            <tr>
              <td class="px-2.5 py-2 font-semibold">{row.symbol}</td>
              <td class="px-2.5 py-2">{row.role}</td>
              <td class="px-2.5 py-2">{row.status}</td>
              <td class="px-2.5 py-2 text-right">{row.multiple}</td>
              <td class="px-2.5 py-2">{row.currency}</td>
              <td class="px-2.5 py-2">{row.inputDates}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else if valuationWorkbench.peerSuppression !== undefined}
    <div class="mt-2 rounded-lg border border-border bg-secondary px-4 py-3 text-sm text-muted-foreground">
      {valuationWorkbench.peerSuppression}
    </div>
  {/if}
  {#if excludedPeerRows.length > 0}
    <div class="mt-4 text-[10px] font-semibold uppercase tracking-wider text-[#5c6066]">
      Excluded-peer diagnostics
    </div>
    <div class="mt-2 space-y-2">
      {#each excludedPeerRows as peer}
        <div class="rounded-lg border border-dashed border-border bg-secondary px-3 py-2 text-[10px]">
          <span class="font-mono font-semibold">{peer.symbol}</span>
          · {peer.role} · {peer.reason}
          {@render citeChips(peer.sourceIds)}
        </div>
      {/each}
    </div>
  {/if}
</section>
