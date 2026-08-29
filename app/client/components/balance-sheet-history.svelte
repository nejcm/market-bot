<script lang="ts">
  import type { Snippet } from "svelte";
  import type { RunWorkspaceBalanceSheetHistoryView, BindSection, RunWorkspaceSectionKey } from "../run-workspace-view";

  interface Props {
    readonly history: RunWorkspaceBalanceSheetHistoryView;
    readonly sectionKey: RunWorkspaceSectionKey;
    readonly citeChips: Snippet<[readonly string[]]>;
    readonly bindSection: BindSection;
  }

  let { history, sectionKey, citeChips, bindSection }: Props = $props();
</script>

<section {@attach bindSection(sectionKey)} class="mt-8.5 scroll-mt-5">
  <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2">
    <span class="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
      Balance sheet & share count
    </span>
    <span class="font-mono text-[10px] text-[#8a8f96]">
      {history.reportingCurrency ?? "currency unavailable"}
    </span>
  </div>
  <div class="mt-3 overflow-x-auto rounded-lg border border-border">
    <table class="w-full min-w-[580px] border-collapse text-left">
      <thead class="bg-secondary text-[9px] uppercase tracking-wider text-muted-foreground">
        <tr>
          <th class="px-2.5 py-2 font-semibold">Period</th>
          <th class="px-2.5 py-2 text-right font-semibold">Cash</th>
          <th class="px-2.5 py-2 text-right font-semibold">Debt</th>
          <th class="px-2.5 py-2 text-right font-semibold">Diluted shares</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-border font-mono text-[10px]">
        {#each history.rows as row}
          <tr>
            <td class="px-2.5 py-2">{row.period}</td>
            <td class="px-2.5 py-2 text-right">{row.cash}</td>
            <td class="px-2.5 py-2 text-right">{row.debt}</td>
            <td class="px-2.5 py-2 text-right">{row.dilutedShares}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {@render citeChips(history.sourceIds)}
  {#if history.notes !== undefined && history.notes.length > 0}
    <p class="mt-2 text-[11px] text-muted-foreground">
      {history.notes.map((note) => note.message).join(" ")}
    </p>
  {/if}
</section>
