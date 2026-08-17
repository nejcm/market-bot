<script lang="ts">
  import type { RunWorkspaceReverseDcfView, BindSection, RunWorkspaceSectionKey } from "../run-workspace-view";

  interface Props {
    readonly reverseDcf: RunWorkspaceReverseDcfView;
    readonly sectionKey: RunWorkspaceSectionKey;
    readonly bindSection: BindSection;
  }

  let { reverseDcf, sectionKey, bindSection }: Props = $props();
</script>

<section {@attach bindSection(sectionKey)} class="mt-8.5 scroll-mt-5">
  <div class="border-b border-border pb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
    Reverse DCF input sensitivity
  </div>
  {#if reverseDcf.status === "suppressed"}
    <div class="mt-3 rounded-lg border border-border bg-secondary px-4 py-3 text-sm text-muted-foreground">
      Suppressed: {reverseDcf.message}
    </div>
  {:else}
    <div class="mt-3 grid gap-2 text-[10px] text-muted-foreground sm:grid-cols-3">
      <div>
        <span class="font-semibold text-foreground">Starting FCF</span><br />
        <span class="font-mono">{reverseDcf.startingFcf}</span><br />
        {reverseDcf.startingFcfDates}
      </div>
      <div>
        <span class="font-semibold text-foreground">Enterprise value</span><br />
        <span class="font-mono">{reverseDcf.enterpriseValue}</span><br />
        {reverseDcf.enterpriseValueDate}
      </div>
      <div>
        <span class="font-semibold text-foreground">Horizon</span><br />
        <span class="font-mono">{reverseDcf.horizonYears} years</span>
      </div>
    </div>
    <div class="mt-3 text-[10px] leading-snug text-muted-foreground">
      Each cell is the five-year FCF growth input that reconciles the row discount rate and column terminal growth assumption.
    </div>
    <div class="mt-3 overflow-x-auto rounded-lg border border-border">
      <table class="w-full min-w-[560px] border-collapse text-right">
        <thead class="bg-secondary text-[9px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th class="px-2.5 py-2 text-left font-semibold">Discount rate</th>
            {#each reverseDcf.terminalGrowthRatesPct as rate}
              <th class="px-2.5 py-2 font-semibold">{rate}% terminal</th>
            {/each}
          </tr>
        </thead>
        <tbody class="divide-y divide-border font-mono text-[10px]">
          {#each reverseDcf.rows as row}
            <tr>
              <td class="px-2.5 py-2 text-left font-semibold">{row.discountRatePct}%</td>
              {#each row.cells as cell}
                <td class="px-2.5 py-2">{cell}</td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>
