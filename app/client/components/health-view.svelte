<script lang="ts">
  import type { ProviderHealthDetail } from "../../types";
  import { jsonBlock, providerHealthRows } from "../view-model";

  interface Props {
    readonly providerHealth: ProviderHealthDetail;
  }

  let { providerHealth }: Props = $props();

  let bannerDismissed = $state(false);

  const providerRows = $derived(providerHealthRows(providerHealth));
  const degradedCount = $derived(providerRows.filter((row) => row.degraded).length);
</script>

<div class="mx-auto max-w-230" data-screen-label="Health">
  <h1 class="text-xl font-semibold tracking-tight">Provider health</h1>
  <div class="mt-1 text-[12.5px] text-[#5c6066]">
    Upstream data providers, as observed by the last fetch cycle.
  </div>

  {#if degradedCount > 0 && !bannerDismissed}
    <div
      class="mt-4.5 flex items-start gap-3 rounded-lg border border-[#d9c89a] bg-[#fbf6ea] px-4 py-3"
    >
      <span
        class="mt-px shrink-0 rounded border border-[#d9c89a] bg-[#f5ecd6] px-1.5 py-px font-mono text-[10px] text-[#8a6116]"
      >
        WARN
      </span>
      <span class="flex-1 text-[12.5px] leading-normal text-[#4a4334]">
        {degradedCount}
        provider {degradedCount === 1 ? "route is" : "routes are"} reporting gaps. Affected runs record
        each miss as a data gap rather than hiding it.
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
      <div class="min-w-160">
        <div
          class="grid grid-cols-[130px_minmax(0,1fr)_120px_80px_80px] gap-3.5 border-b border-border bg-secondary px-4.5 py-2.5 font-mono text-[10px] tracking-[0.08em] text-muted-foreground"
        >
          <div>PROVIDER</div>
          <div>ROUTE / NOTE</div>
          <div>STATUS</div>
          <div>SOURCES</div>
          <div>GAPS</div>
        </div>
        {#each providerRows as row}
          <div
            class="grid grid-cols-[130px_minmax(0,1fr)_120px_80px_80px] items-center gap-3.5 border-b border-[#f0ede7] px-4.5 py-3 last:border-b-0"
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
              <span
                class="size-1.75 rounded-full"
                style="background: {row.degraded ? '#c4942e' : '#4ba3b2'}"
              ></span>
              <span
                class="font-mono text-[11px]"
                style="color: {row.degraded ? '#8a6116' : '#166e7d'}"
              >
                {row.degraded ? "degraded" : "operational"}
              </span>
            </div>
            <div class="font-mono text-[11.5px] text-[#5c6066]">{row.total}</div>
            <div class="font-mono text-[11.5px] {row.gaps > 0 ? 'text-[#8a6116]' : 'text-[#5c6066]'}">
              {row.gaps}
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
