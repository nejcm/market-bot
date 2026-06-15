<script lang="ts">
  import type { CalibrationDetail } from "../../types";
  import {
    calibrationAutopsyCauses,
    calibrationHeadline,
    calibrationSampleWarning,
    calibrationSlices,
    formatDateMinute,
    reliabilityBins,
    type CalibrationSliceGroup,
  } from "../view-model";
  import type { View } from "./console-types";
  import CalibrationReliabilityChart from "./calibration-reliability-chart.svelte";

  interface Props {
    readonly calibration: CalibrationDetail;
    readonly onNavigate: (view: View) => void;
  }

  let { calibration, onNavigate }: Props = $props();

  const SLICE_GROUPS: readonly { readonly group: CalibrationSliceGroup; readonly title: string }[] =
    [
      { group: "byKind", title: "By forecast kind" },
      { group: "byAssetClass", title: "By asset class" },
      { group: "byJobType", title: "By job type" },
      { group: "byMarketUpdateCadence", title: "By cadence" },
      { group: "byHorizonBucket", title: "By horizon" },
      { group: "byMarketRegime", title: "By market regime" },
    ];

  const headline = $derived(calibrationHeadline(calibration));
  const sampleWarning = $derived(calibrationSampleWarning(headline));
  const bins = $derived(reliabilityBins(calibration));
  const autopsyCauseRows = $derived(calibrationAutopsyCauses(calibration));
  const sliceTables = $derived(
    SLICE_GROUPS.map((entry) => ({
      ...entry,
      rows: calibrationSlices(calibration, entry.group),
    })).filter((entry) => entry.rows.length > 0),
  );
  const hasSummary = $derived(calibration.summary !== undefined);

  function formatScore(value: number | undefined): string {
    return value === undefined ? "—" : value.toFixed(3);
  }

  function formatSkill(value: number | undefined): string {
    if (value === undefined) {
      return "—";
    }

    return `${value > 0 ? "+" : ""}${value.toFixed(3)}`;
  }
</script>

<div class="mx-auto max-w-230" data-screen-label="Calibration">
  <h1 class="text-xl font-semibold tracking-tight">Calibration</h1>
  <div class="mt-1 text-[12.5px] text-[#5c6066]">
    How well stated forecast probabilities match observed resolution rates. Accuracy measurement,
    not investment conviction.
  </div>

  {#if !hasSummary}
    <div
      class="mt-5 rounded-lg border border-dashed border-input p-9 text-center text-sm text-muted-foreground"
    >
      No calibration summary yet.
      <button
        class="text-[#166e7d] underline underline-offset-2 transition hover:text-[#0e4954] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        type="button"
        onclick={() => onNavigate("jobs")}
      >
        Queue a score or calibration job
      </button>
      to build one from resolved forecasts.
    </div>
  {:else}
    {#if sampleWarning.show}
      <div
        class="mt-5 flex items-start gap-3 rounded-lg border border-[#d9c89a] bg-[#fbf6ea] px-4 py-3"
      >
        <span
          class="mt-px shrink-0 rounded border border-[#d9c89a] bg-[#f5ecd6] px-1.5 py-px font-mono text-[10px] text-[#8a6116]"
        >
          WARN
        </span>
        <span class="text-[12.5px] leading-normal text-[#4a4334]">
          Small sample ({sampleWarning.resolvedCount} of {sampleWarning.minimum} minimum) —
          calibration metrics are not yet reliable.
        </span>
      </div>
    {/if}

    <div class="mt-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
      <div class="rounded-lg border border-border bg-card px-4 py-3.5">
        <div class="font-mono text-2xl font-medium text-foreground">
          {formatScore(headline.brierScore)}
        </div>
        <div class="mt-1 text-[11px] uppercase tracking-wider text-muted-foreground">
          Brier score
        </div>
        <div class="mt-1.5 text-xs text-[#5c6066]">0 = perfect · 0.25 = always 0.5</div>
      </div>
      <div class="rounded-lg border border-border bg-card px-4 py-3.5">
        <div class="font-mono text-2xl font-medium text-foreground">
          {formatSkill(headline.brierSkillScore)}
        </div>
        <div class="mt-1 text-[11px] uppercase tracking-wider text-muted-foreground">
          Brier skill score
        </div>
        <div class="mt-1.5 text-xs text-[#5c6066]">0 = coin-flip baseline · 1 = perfect</div>
      </div>
      <div class="rounded-lg border border-border bg-card px-4 py-3.5">
        <div class="font-mono text-2xl font-medium text-foreground">
          {headline.resolvedCount}
        </div>
        <div class="mt-1 text-[11px] uppercase tracking-wider text-muted-foreground">
          Resolved forecasts
        </div>
        <div class="mt-1.5 text-xs text-[#5c6066]">scored against observations</div>
      </div>
      <div class="rounded-lg border border-border bg-card px-4 py-3.5">
        <div class="font-mono text-2xl font-medium text-foreground">
          {headline.generatedAt === undefined
            ? "—"
            : formatDateMinute(headline.generatedAt).split(",")[0]}
        </div>
        <div class="mt-1 text-[11px] uppercase tracking-wider text-muted-foreground">As of</div>
        <div class="mt-1.5 text-xs text-[#5c6066]">
          {formatDateMinute(headline.generatedAt)}
        </div>
      </div>
    </div>

    <div class="mt-3.5 rounded-lg border border-border bg-card px-4.5 py-4">
      <div class="flex items-baseline justify-between">
        <span class="text-xs font-semibold">Reliability</span>
        <span class="font-mono text-[10.5px] text-muted-foreground">
          stated probability vs observed hit rate · small n is noisy
        </span>
      </div>
      <CalibrationReliabilityChart {bins} />
    </div>

    <div class="mt-3.5 overflow-hidden rounded-lg border border-border bg-card">
      <div
        class="flex items-baseline justify-between border-b border-border bg-secondary px-4.5 py-2.5"
      >
        <span class="text-xs font-semibold">Forecast Error Taxonomy</span>
        <span class="font-mono text-[10.5px] text-muted-foreground">
          material errors only · artifact-backed
        </span>
      </div>
      {#if autopsyCauseRows.length === 0}
        <div class="px-4.5 py-3 text-[12.5px] text-muted-foreground">
          No material forecast-error autopsies yet.
        </div>
      {:else}
        {#each autopsyCauseRows as row}
          <div
            class="grid grid-cols-[minmax(0,1fr)_56px] items-center gap-3.5 border-b border-[#f0ede7] px-4.5 py-2.5 last:border-b-0"
          >
            <div class="truncate font-mono text-[11.5px] text-[#45494e]">{row.cause}</div>
            <div class="text-right font-mono text-[11.5px] text-[#5c6066]">{row.count}</div>
          </div>
        {/each}
      {/if}
    </div>

    {#if sliceTables.length > 0}
      <div class="mt-3.5 grid gap-3 md:grid-cols-2">
        {#each sliceTables as table}
          <div class="overflow-hidden rounded-lg border border-border bg-card">
            <div
              class="grid grid-cols-[minmax(0,1fr)_90px_56px] gap-3.5 border-b border-border bg-secondary px-4.5 py-2.5 font-mono text-[10px] tracking-[0.08em] text-muted-foreground"
            >
              <div>{table.title.toUpperCase()}</div>
              <div class="text-right">BRIER</div>
              <div class="text-right">N</div>
            </div>
            {#each table.rows as row}
              <div
                class="grid grid-cols-[minmax(0,1fr)_90px_56px] items-center gap-3.5 border-b border-[#f0ede7] px-4.5 py-2.5 last:border-b-0"
              >
                <div class="truncate text-[12.5px] font-medium">{row.key}</div>
                <div class="text-right font-mono text-[11.5px] text-[#5c6066]">
                  {row.brierScore.toFixed(3)}
                </div>
                <div class="text-right font-mono text-[11.5px] text-[#5c6066]">{row.count}</div>
              </div>
            {/each}
          </div>
        {/each}
      </div>
    {/if}
  {/if}

  {#if calibration.markdown !== undefined}
    <div class="mt-3.5 overflow-x-auto rounded-lg bg-[#16181a] px-5 py-4.5">
      <pre class="font-mono text-xs leading-relaxed text-[#c7cdd4]">{calibration.markdown}</pre>
    </div>
  {/if}
</div>
