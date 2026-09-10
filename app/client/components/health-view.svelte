<script lang="ts">
  import type { ProviderHealthDetail } from "../../types";
  import {
    jsonBlock,
    providerHealthIssueCounts,
    providerHealthRows,
    type ProviderHealthRowStatus,
  } from "../view-model";

  interface Props {
    readonly providerHealth: ProviderHealthDetail;
  }

  let { providerHealth }: Props = $props();

  let blockingBannerDismissed = $state(false);
  let warningBannerDismissed = $state(false);

  const providerRows = $derived(providerHealthRows(providerHealth));
  /* Counted from `validation.routeClassifications`, not from table rows: the synthetic
   * classifications (required coverage, news, scoring, Calibration, Run Artifact Index) have no
   * provider route, and counting rows made the banner contradict the health report below it. */
  const issueCounts = $derived(providerHealthIssueCounts(providerHealth, providerRows));
  const warningCount = $derived(issueCounts.warning);
  const blockingCount = $derived(issueCounts.blocking);
  const hasHealthReport = $derived(providerHealth.markdown !== undefined);

  const STATUS_STYLE: Record<
    ProviderHealthRowStatus,
    { readonly dot: string; readonly fg: string; readonly label: string }
  > = {
    operational: { dot: "#4ba3b2", fg: "#166e7d", label: "operational" },
    informational: { dot: "#9aa1a8", fg: "#8a8f96", label: "informational" },
    degraded: { dot: "#c4942e", fg: "#8a6116", label: "degraded" },
    blocking: { dot: "#c25f52", fg: "#9c3a2c", label: "blocking" },
  };
</script>

<div class="mx-auto max-w-230" data-screen-label="Health">
  <h1 class="text-xl font-semibold tracking-tight">Provider health</h1>
  <div class="mt-1 text-[12.5px] text-[#5c6066]">
    Upstream data providers, as observed by the last fetch cycle.
  </div>

  {#if blockingCount > 0 && !blockingBannerDismissed}
    <div
      class="mt-4.5 flex items-start gap-3 rounded-lg border border-[#e0b3aa] bg-[#fbefec] px-4 py-3"
    >
      <span
        class="mt-px shrink-0 rounded border border-[#e0b3aa] bg-[#f6ddd6] px-1.5 py-px font-mono text-[10px] text-[#9c3a2c]"
      >
        FAIL
      </span>
      <span class="flex-1 text-[12.5px] leading-normal text-[#4a3330]">
        {blockingCount}
        blocking {blockingCount === 1 ? "issue" : "issues"} in the last validation pass.
        {#if issueCounts.offTableBlocking > 0}
          Of these, {issueCounts.offTableBlocking}
          {issueCounts.offTableBlocking === 1
            ? "is a validation check, not a provider route"
            : "are validation checks, not provider routes"} — required coverage, news, scoring or the
          Run Artifact Index — with no row in the provider table.
        {/if}
        {#if hasHealthReport}
          Every issue and its reason is listed in the Route classifications table of the health report
          below.
        {/if}
      </span>
      <button
        class="px-0.5 text-sm text-[#8a6255] transition hover:text-[#4a3330] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9c3a2c]"
        type="button"
        aria-label="Dismiss blocking warning"
        onclick={() => (blockingBannerDismissed = true)}
      >
        ✕
      </button>
    </div>
  {/if}

  {#if warningCount > 0 && !warningBannerDismissed}
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
        warning {warningCount === 1 ? "issue" : "issues"} in the last validation pass. Affected runs
        record each miss as a Source Gap, or — when a fallback provider covered the request — as a
        degraded endpoint rather than hiding it.
        {#if issueCounts.offTableWarning > 0}
          Of these, {issueCounts.offTableWarning}
          {issueCounts.offTableWarning === 1
            ? "is a validation check, not a provider route"
            : "are validation checks, not provider routes"} — pending Calibration, for example — with no
          row in the provider table.
        {/if}
        {#if hasHealthReport}
          Every issue and its reason is listed in the Route classifications table of the health report
          below.
        {/if}
      </span>
      <button
        class="px-0.5 text-sm text-[#8a7a52] transition hover:text-[#4a4334] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8a6116]"
        type="button"
        aria-label="Dismiss warning"
        onclick={() => (warningBannerDismissed = true)}
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
            (row.status === "degraded" || row.status === "blocking") && row.gaps > 0
              ? tone.fg
              : "#5c6066"}
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
