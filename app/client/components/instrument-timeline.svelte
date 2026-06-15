<script lang="ts">
  import type { InstrumentTimelineDetail, InstrumentTimelineForecast } from "../../types";
  import { formatClose, formatDate, formatDateMinute } from "../view-model";

  interface Props {
    readonly detail: InstrumentTimelineDetail | null;
    readonly loading: boolean;
    readonly onOpenRun: (runId: string) => void;
    readonly onGoHome: () => void;
  }

  let { detail, loading, onOpenRun, onGoHome }: Props = $props();

  const WIDTH = 760;
  const HEIGHT = 220;
  const PADDING_LEFT = 58;
  const PADDING_RIGHT = 18;
  const PADDING_TOP = 18;
  const PADDING_BOTTOM = 30;
  const MAX_DATE_TICKS = 8;
  const plotWidth = WIDTH - PADDING_LEFT - PADDING_RIGHT;
  const plotHeight = HEIGHT - PADDING_TOP - PADDING_BOTTOM;
  const baselineY = HEIGHT - PADDING_BOTTOM;

  function dateTickStep(length: number): number {
    return Math.max(1, Math.ceil(length / MAX_DATE_TICKS));
  }

  const points = $derived.by(() => {
    const prices = detail?.pricePoints ?? [];
    if (prices.length === 0) {
      return [];
    }
    const closes = prices.map((point) => point.close);
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const range = max - min || 1;
    return prices.map((point, index) => ({
      ...point,
      x: PADDING_LEFT + (index / Math.max(1, prices.length - 1)) * plotWidth,
      y: PADDING_TOP + ((max - point.close) / range) * plotHeight,
    }));
  });
  const pathData = $derived(
    points
      .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
      .join(" "),
  );
  const minClose = $derived(
    points.length === 0 ? 0 : Math.min(...points.map((point) => point.close)),
  );
  const maxClose = $derived(
    points.length === 0 ? 0 : Math.max(...points.map((point) => point.close)),
  );
  const dateTicks = $derived(
    points.filter((_, index) => index % dateTickStep(points.length) === 0 || index === points.length - 1),
  );

  const OUTCOME_CLASS: Record<string, string> = {
    "event-true": "border-[#9fc2c8] bg-[#e7f1f3] text-[#166e7d]",
    "event-false": "border-border bg-secondary text-[#5c6066]",
    pending: "border-[#c9c4ba] bg-transparent text-[#8a8f96]",
    voided: "border-[#d9c89a] bg-[#fbf6ea] text-[#8a6116]",
    unscored: "border-[#d9c89a] bg-[#fbf6ea] text-[#8a6116]",
  };
  const OUTCOME_LABEL: Record<string, string> = {
    "event-true": "event true",
    "event-false": "event false",
    pending: "pending",
    voided: "voided",
    unscored: "unscored",
  };

  function pct(value: number): string {
    return `${String(Math.round(value * 100))}%`;
  }

  function rowOutcome(forecast: InstrumentTimelineForecast): string {
    return OUTCOME_LABEL[forecast.outcome] ?? forecast.outcome;
  }
</script>

{#if loading}
  <div class="rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground">
    Loading instrument timeline...
  </div>
{:else if detail === null}
  <div
    class="rounded-lg border border-dashed border-input p-9 text-center text-sm text-muted-foreground"
  >
    Select an instrument to inspect its timeline.
  </div>
{:else}
  <div data-screen-label="Instrument timeline">
    <div class="font-mono text-[11px] text-muted-foreground">
      <button
        class="text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        type="button"
        onclick={onGoHome}
      >
        instruments
      </button>
      / {detail.assetClass}:{detail.symbol}
    </div>

    <div class="mt-2.5 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-[21px] font-semibold tracking-tight">{detail.symbol}</h1>
        <div class="mt-1 font-mono text-xs text-[#5c6066]">{detail.assetClass}</div>
      </div>
      <div class="grid grid-cols-2 gap-4 text-right sm:grid-cols-4">
        <div>
          <div class="font-mono text-[17px] font-medium">{detail.counts.total}</div>
          <div class="mt-0.5 text-[10.5px] uppercase tracking-wider text-muted-foreground">
            Forecasts
          </div>
        </div>
        <div>
          <div class="font-mono text-[17px] font-medium">{detail.counts.eventTrue}</div>
          <div class="mt-0.5 text-[10.5px] uppercase tracking-wider text-muted-foreground">
            Event true
          </div>
        </div>
        <div>
          <div class="font-mono text-[17px] font-medium">{detail.counts.eventFalse}</div>
          <div class="mt-0.5 text-[10.5px] uppercase tracking-wider text-muted-foreground">
            Event false
          </div>
        </div>
        <div>
          <div class="font-mono text-[17px] font-medium">
            {detail.counts.pending + detail.counts.voided + detail.counts.unscored}
          </div>
          <div class="mt-0.5 text-[10.5px] uppercase tracking-wider text-muted-foreground">
            Open
          </div>
        </div>
      </div>
    </div>

    {#if detail.warnings.malformedRunCount > 0 || detail.warnings.malformedPredictionCount > 0}
      <div class="mt-4 rounded-lg border border-[#d9c89a] bg-[#fbf6ea] px-4 py-3 text-xs text-[#4a4334]">
        Skipped malformed artifacts: {detail.warnings.malformedRunCount} run(s),
        {detail.warnings.malformedPredictionCount} forecast expression(s).
      </div>
    {/if}

    <section class="mt-5 rounded-lg border border-border bg-card px-4.5 py-4">
      <div class="flex items-baseline justify-between">
        <h2 class="text-sm font-semibold">Verified closes</h2>
        <span class="font-mono text-[10.5px] text-muted-foreground">{detail.source} timeline</span>
      </div>
      {#if points.length === 0}
        <div class="mt-3 rounded-md border border-dashed border-input p-6 text-sm text-muted-foreground">
          No verified close series is available for this instrument.
        </div>
      {:else}
        <svg
          class="mt-3 h-[220px] w-full"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label="Verified close history for {detail.symbol}"
        >
          <line
            x1={PADDING_LEFT}
            x2={WIDTH - PADDING_RIGHT}
            y1={baselineY}
            y2={baselineY}
            stroke="currentColor"
            class="text-border"
          />
          <text
            x={PADDING_LEFT - 8}
            y={PADDING_TOP + 4}
            text-anchor="end"
            class="fill-muted-foreground font-mono text-[10px]"
          >
            {formatClose(maxClose)}
          </text>
          <text
            x={PADDING_LEFT - 8}
            y={baselineY + 4}
            text-anchor="end"
            class="fill-muted-foreground font-mono text-[10px]"
          >
            {formatClose(minClose)}
          </text>
          <path d={pathData} fill="none" stroke="#4ba3b2" stroke-width="2.5" />
          {#each dateTicks as tick}
            <text
              x={tick.x}
              y={HEIGHT - 10}
              text-anchor="middle"
              class="fill-muted-foreground font-mono text-[9.5px]"
            >
              {tick.date.slice(5)}
            </text>
          {/each}
        </svg>
      {/if}
    </section>

    <section class="mt-5 rounded-lg border border-border bg-card px-4.5 py-4">
      <div class="flex items-baseline justify-between">
        <h2 class="text-sm font-semibold">Forecasts</h2>
        <span class="font-mono text-[10.5px] text-muted-foreground">
          {formatDate(detail.generatedAt)}
        </span>
      </div>
      {#if detail.entries.length === 0}
        <div class="mt-3 py-4 text-sm text-muted-foreground">
          No forecasts found for this instrument.
        </div>
      {:else}
        <div class="mt-3 divide-y divide-[#f0ede7]">
          {#each detail.entries as forecast}
            <div class="grid gap-3 py-3 lg:grid-cols-[120px_minmax(0,1fr)_92px_96px_112px]">
              <button
                class="text-left font-mono text-[11px] text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                type="button"
                onclick={() => onOpenRun(forecast.runId)}
              >
                {formatDateMinute(forecast.generatedAt)}
              </button>
              <div>
                <div class="font-serif text-sm leading-[1.5] text-[#1f2225]">{forecast.claim}</div>
                <div class="mt-1 flex flex-wrap gap-1.5 font-mono text-[10px] text-[#8a8f96]">
                  <span>{forecast.jobType}</span>
                  <span>{forecast.scope}</span>
                  <span>{forecast.subject}</span>
                  {#if forecast.missAutopsyCause !== undefined}
                    <span>cause {forecast.missAutopsyCause}</span>
                  {/if}
                </div>
              </div>
              <div class="font-mono text-xs font-medium">{pct(forecast.probability)}</div>
              <div class="font-mono text-[11.5px] text-[#5c6066]">
                {forecast.horizonTradingDays} td
              </div>
              <div>
                <span
                  class="rounded border px-1.75 py-0.5 font-mono text-[10px] {OUTCOME_CLASS[
                    forecast.outcome
                  ]}"
                >
                  {rowOutcome(forecast)}
                </span>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </section>
  </div>
{/if}
