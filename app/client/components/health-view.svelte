<script lang="ts">
  import type { ProviderHealthDetail } from "../../types";
  import { jsonBlock, providerHealthRows, type ProviderHealthRowStatus } from "../view-model";

  interface Props {
    readonly providerHealth: ProviderHealthDetail;
  }

  let { providerHealth }: Props = $props();

  let bannerDismissed = $state(false);

  const providerRows = $derived(providerHealthRows(providerHealth));
  const warningCount = $derived(providerRows.filter((row) => row.status === "degraded").length);

  const STATUS_STYLE: Record<
    ProviderHealthRowStatus,
    { readonly dot: string; readonly fg: string; readonly label: string }
  > = {
    operational: { dot: "#4ba3b2", fg: "#166e7d", label: "operational" },
    informational: { dot: "#9aa1a8", fg: "#8a8f96", label: "informational" },
    degraded: { dot: "#c4942e", fg: "#8a6116", label: "degraded" },
  };
</script>

<div class="mx-auto max-w-230" data-screen-label="Health">
  <h1 class="text-xl font-semibold tracking-tight">Provider health</h1>
  <div class="mt-1 text-[12.5px] text-[#5c6066]">
    Upstream data providers, as observed by the last fetch cycle.
  </div>

  {#if warningCount > 0 && !bannerDismissed}
    <div
      class="mt-4.5 flex items-start gap-3 rounded-lg border border-[#d9c89a] bg-[#fbf6ea] px-4 py-3"
    >
      <span
        class="mt-px shrink-0 rounded border border-[#d9c89a] bg-[#f5ecd6] px-1.5 py-px font-mono text-[10px] text-[#8a6116]"
      >
        WARN
      </span>
      <span class="flex-1 text-[12.5px] leading-normal text-[#4a4334]">
        {warningCount}
        provider {warningCount === 1 ? "route is" : "routes are"} degraded. Affected runs record each
        miss as a data gap, or — when a fallback provider covered the request — as a degraded endpoint
        rather than hiding it.
      </span>
      <button
        class="px-0.5 text-sm text-[#8a7a52] transition hover:text-[#4a4334] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8a6116]"
        type="button"
        aria-label="Dismiss warning"
        onclick={() => (bannerDismissed = true)}
      >
        ✕
      </button>
    </div>
  {/if}

  {#if providerRows.length > 0}
    <div class="mt-4 overflow-x-auto rounded-lg border border-border bg-card">
      <div class="min-w-180">
        <div
          class="grid grid-cols-[130px_minmax(0,1fr)_130px_64px_64px_120px] gap-3.5 border-b border-border bg-secondary px-4.5 py-2.5 font-mono text-[10px] tracking-[0.08em] text-muted-foreground"
        >
          <div>PROVIDER</div>
          <div>ROUTE / NOTE</div>
          <div>STATUS</div>
          <div>TOTAL</div>
          <div>GAPS</div>
          <div>DEGRADED RUNS</div>
        </div>
        {#each providerRows as row}
          {@const tone = STATUS_STYLE[row.status]}
          {@const gapColor =
            row.status === "degraded" && row.gaps > 0 ? "#8a6116" : "#5c6066"}
          {@const degradedRunColor = row.degradedRuns > 0 ? "#8a6116" : "#5c6066"}
          <div
            class="grid grid-cols-[130px_minmax(0,1fr)_130px_64px_64px_120px] items-center gap-3.5 border-b border-[#f0ede7] px-4.5 py-3 last:border-b-0"
          >
            <div class="truncate text-[12.5px] font-medium">{row.provider}</div>
            <div class="min-w-0">
              <div class="truncate font-mono text-[11px] text-[#5c6066]">{row.route}</div>
              {#if row.note !== ""}
                <div class="truncate text-xs text-muted-foreground" title={row.note}>
                  {row.note}
                </div>
              {/if}
            </div>
            <div class="flex items-center gap-1.75">
              <span class="size-1.75 rounded-full" style="background: {tone.dot}"></span>
              <span class="font-mono text-[11px]" style="color: {tone.fg}">
                {tone.label}
              </span>
            </div>
            <div data-col="total" class="font-mono text-[11.5px] text-[#5c6066]">{row.total}</div>
            <div data-col="gaps" class="font-mono text-[11.5px]" style="color: {gapColor}">
              {row.gaps}
            </div>
            <div
              data-col="degraded-runs"
              class="font-mono text-[11.5px]"
              style="color: {degradedRunColor}"
            >
              {row.degradedRuns}
            </div>
          </div>
        {/each}
      </div>
    </div>
  {:else}
    <div class="mt-4 overflow-x-auto rounded-lg bg-[#16181a] px-5 py-4.5">
      <pre class="font-mono text-xs leading-relaxed text-[#c7cdd4]">{jsonBlock(
          providerHealth.summary,
        )}</pre>
    </div>
  {/if}

  {#if providerHealth.markdown !== undefined}
    <div class="mt-3.5 overflow-x-auto rounded-lg bg-[#16181a] px-5 py-4.5">
      <pre class="font-mono text-xs leading-relaxed text-[#c7cdd4]">{providerHealth.markdown}</pre>
    </div>
  {/if}
</div>
