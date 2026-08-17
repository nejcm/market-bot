<script lang="ts">
  import type { Snippet } from "svelte";
  import { formatClose, formatDateMinute } from "../view-model";
  import type {
    ForecastGroup,
    ForecastRollup,
    PredictionTargetHealth,
    ScoredForecast,
  } from "../../report-artifact-view";
  import type { BindSection } from "../run-workspace-view";

  interface Props {
    readonly forecastItems: readonly ScoredForecast[];
    readonly groupedForecastItems: readonly ForecastGroup[];
    readonly forecastStats: ForecastRollup;
    readonly targetHealth: PredictionTargetHealth | undefined;
    readonly assetClass: string;
    readonly compact?: boolean;
    readonly citeChips: Snippet<[readonly string[]]>;
    readonly bindSection: BindSection;
    readonly onOpenInstrument: (assetClass: string, symbol: string) => void;
  }

  let {
    forecastItems,
    groupedForecastItems,
    forecastStats,
    targetHealth,
    assetClass,
    compact = false,
    citeChips,
    bindSection,
    onOpenInstrument,
  }: Props = $props();

  const DISAGREEMENT_BADGE_CLASSES: Record<string, string> = {
    low: "border-[#cfe0e3] bg-accent text-primary",
    medium: "border-[#d9c89a] bg-[#f5ecd6] text-[#8a6116]",
    high: "border-[#b8bdc3] bg-[#eef0f2] text-[#3f454b]",
  };

  function percent(value: number): string {
    return `${String(Math.round(value * 100))}%`;
  }

  function spreadPoints(value: number): string {
    return `${String(Math.round(value * 100))}pp`;
  }

  function subjectSymbols(subject: string | undefined): readonly string[] {
    if (subject === undefined) {
      return [];
    }
    return subject
      .split(":")
      .map((part) => part.trim().toUpperCase())
      .filter((part) => /^[A-Z0-9._-]+$/u.test(part));
  }
</script>

<section {@attach bindSection("forecasts")} class="mt-8.5 scroll-mt-5">
  <div class="flex items-baseline justify-between border-b border-border pb-2">
    <div class="flex items-center gap-2">
      <span class="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
        Observable forecasts
      </span>
      {#if targetHealth !== undefined && !targetHealth.targetMet}
        <span
          class="rounded border border-[#d9c89a] bg-[#f5ecd6] px-1.5 py-px font-mono text-[10px] text-[#8a6116]"
        >
          BELOW TARGET
        </span>
      {/if}
    </div>
    <span class="font-mono text-[10px] text-[#a8acb1]">
      {#if targetHealth !== undefined}
        {targetHealth.count} / {targetHealth.target} target ·
      {/if}
      {#if forecastStats.resolved > 0}
        scored {forecastStats.resolved}/{forecastStats.total} ·
        {forecastStats.hits} event true · {forecastStats.misses} event false ·
        {#if forecastStats.voided > 0}
          {forecastStats.voided} voided ·
        {/if}
      {/if}
      td = trading days
    </span>
  </div>
  {#if forecastItems.length === 0}
    <div class="py-4 text-sm text-muted-foreground">No forecasts emitted for this run.</div>
  {/if}
  {#each groupedForecastItems as group}
    {#if group.antecedent !== undefined}
      <div
        class="border-b border-[#f0ede7] bg-[#fbfaf7] px-2 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[#5c6066]"
      >
        If {group.antecedent}
      </div>
    {/if}
    {#each group.forecasts as forecast}
      <div
        class="grid items-center gap-2 border-b border-[#f0ede7] py-3 sm:grid-cols-[minmax(0,1fr)_110px_130px_64px_132px] sm:gap-4"
      >
        <div class="font-serif text-sm leading-normal text-[#1f2225]">
          {forecast.claim}
          {@render citeChips(forecast.sourceIds)}
          {#if !compact && forecast.score?.resolved === true && forecast.score.close0 !== undefined && forecast.score.closeN !== undefined}
            <span class="mt-1 block font-mono text-[10.5px] text-[#8a8f96]">
              close {formatClose(forecast.score.close0)} → {formatClose(forecast.score.closeN)}
              {#if forecast.score.changePct !== undefined}
                ({forecast.score.changePct > 0 ? "+" : ""}{forecast.score.changePct.toFixed(1)}%)
              {/if}
              {#if forecast.score.observedAt !== undefined}
                · observed {formatDateMinute(forecast.score.observedAt)}
              {/if}
            </span>
          {/if}
          {#if !compact && forecast.missAutopsy !== undefined}
            <span class="mt-1 block text-[11.5px] leading-normal text-[#5c6066]">
              Autopsy: {forecast.missAutopsy.rationale}
            </span>
          {/if}
        </div>
        <div>
          {#if forecast.kind !== undefined}
            <span
              class="rounded border border-border bg-secondary px-1.75 py-0.5 font-mono text-[10px] text-[#5c6066]"
            >
              {forecast.kind}
            </span>
          {/if}
          <div class="mt-1 flex flex-wrap gap-1">
            {#each subjectSymbols(forecast.subject) as symbol}
              <button
                class="rounded border border-[#cfe0e3] bg-accent px-1.5 py-0.5 font-mono text-[9.5px] text-primary hover:border-[#9fc2c8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                type="button"
                onclick={() => onOpenInstrument(assetClass, symbol)}
              >
                {symbol}
              </button>
            {/each}
          </div>
        </div>
        <div class="flex items-center gap-2">
          {#if forecast.probability !== undefined}
            {@const pct = Math.round(forecast.probability * 100)}
            <div class="h-1 flex-1 rounded-sm bg-[#f0ede7]">
              <div class="h-1 rounded-sm bg-[#4ba3b2]" style="width: {pct}%"></div>
            </div>
            <span class="w-8.5 text-right font-mono text-xs font-medium">{pct}%</span>
          {/if}
        </div>
        <div class="text-left font-mono text-[11.5px] text-[#5c6066] sm:text-right">
          {forecast.horizonTradingDays === undefined ? "" : `${forecast.horizonTradingDays} td`}
        </div>
        <div class="flex flex-wrap gap-1.5 sm:justify-end">
          {#if forecast.score?.outcome === "hit"}
            <span
              class="rounded border border-[#9fc2c8] bg-[#e7f1f3] px-1.75 py-0.5 font-mono text-[10px] text-[#166e7d]"
            >
              EVENT TRUE
            </span>
          {:else if forecast.score?.outcome === "miss"}
            <span
              class="rounded border border-border bg-secondary px-1.75 py-0.5 font-mono text-[10px] text-[#5c6066]"
            >
              EVENT FALSE
            </span>
          {:else if forecast.score?.status === "voided"}
            <span
              class="rounded border border-[#d9c89a] bg-[#fbf6ea] px-1.75 py-0.5 font-mono text-[10px] text-[#8a6116]"
              title={forecast.score?.pendingReason ?? "condition unmet"}
            >
              VOIDED
            </span>
          {:else if forecast.score?.status === "active-pending"}
            <span
              class="rounded border border-dashed border-[#9fc2c8] px-1.75 py-0.5 font-mono text-[10px] text-[#166e7d]"
              title={forecast.score?.pendingReason ?? "condition met; consequent pending"}
            >
              ACTIVE
            </span>
          {:else if forecast.score?.status === "pending-condition"}
            <span
              class="rounded border border-dashed border-[#c9c4ba] px-1.75 py-0.5 font-mono text-[10px] text-[#8a8f96]"
              title={forecast.score?.pendingReason ?? "condition pending"}
            >
              CONDITION PENDING
            </span>
          {:else if forecast.score?.status === "abandoned"}
            <span
              class="rounded border border-[#d9c89a] bg-[#fbf6ea] px-1.75 py-0.5 font-mono text-[10px] text-[#8a6116]"
              title={forecast.score?.pendingReason ?? "scoring abandoned"}
            >
              ABANDONED
            </span>
          {:else}
            <span
              class="rounded border border-dashed border-[#c9c4ba] px-1.75 py-0.5 font-mono text-[10px] text-[#8a8f96]"
              title={forecast.score?.pendingReason ?? "not yet scored"}
            >
              PENDING
            </span>
          {/if}
          {#if !compact && forecast.forecastDisagreement !== undefined}
            <span
              class="rounded border px-1.75 py-0.5 font-mono text-[10px] {DISAGREEMENT_BADGE_CLASSES[
                forecast.forecastDisagreement.band
              ]}"
              title="Forecast Disagreement: {forecast.forecastDisagreement.band} spread; mean {percent(
                forecast.forecastDisagreement.meanProbability,
              )}; spread {spreadPoints(forecast.forecastDisagreement.probabilitySpread)}; {forecast
                .forecastDisagreement.participantCount} model probabilities"
            >
              FD {forecast.forecastDisagreement.band.toUpperCase()}
              {spreadPoints(forecast.forecastDisagreement.probabilitySpread)}
            </span>
          {/if}
          {#if !compact && forecast.missAutopsy !== undefined}
            <span
              class="rounded border border-[#d9c89a] bg-[#fbf6ea] px-1.75 py-0.5 font-mono text-[10px] text-[#8a6116]"
              title={forecast.missAutopsy.supportingSignals.join("; ") || forecast.missAutopsy.rationale}
            >
              AUTOPSY {forecast.missAutopsy.cause}
            </span>
          {/if}
        </div>
      </div>
    {/each}
  {/each}
</section>
