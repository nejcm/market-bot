<script lang="ts">
  import { onMount } from "svelte";
  import {
    ColorType,
    CrosshairMode,
    LineSeries,
    LineStyle,
    createChart,
    createSeriesMarkers,
    type IChartApi,
    type ISeriesApi,
    type ISeriesMarkersPluginApi,
    type LineData,
    type SeriesMarker,
    type Time,
  } from "lightweight-charts";
  import { formatClose, type SnapshotView } from "../view-model";

  interface Props {
    readonly snapshot: SnapshotView;
    readonly horizons: readonly number[];
  }

  let { snapshot, horizons }: Props = $props();

  const CHART_HEIGHT = 260;
  const MAX_HORIZON_TICKS = 4;

  const GUIDE_KEYS = [
    { key: "ema10", label: "ema10" },
    { key: "sma50", label: "sma50" },
    { key: "sma200", label: "sma200" },
    { key: "bollUpper", label: "boll+" },
    { key: "bollLower", label: "boll-" },
  ] as const;

  const INDICATOR_TILES = [
    { key: "rsi14", label: "RSI 14" },
    { key: "macd", label: "MACD" },
    { key: "macdSignal", label: "MACD signal" },
    { key: "atr14", label: "ATR 14" },
    { key: "ema10", label: "EMA 10" },
    { key: "sma50", label: "SMA 50" },
    { key: "sma200", label: "SMA 200" },
  ] as const;

  let chartEl = $state<HTMLDivElement>();
  let chart: IChartApi | null = null;
  let lineSeries: ISeriesApi<"Line"> | null = null;
  let seriesMarkers: ISeriesMarkersPluginApi<Time> | null = null;
  let observer: ResizeObserver | null = null;

  const lineData = $derived<readonly LineData<Time>[]>(
    snapshot.recentCloses.map((entry) => ({ time: entry.date, value: entry.close })),
  );
  const lastClose = $derived(snapshot.recentCloses.at(-1));
  const lastCloseLabel = $derived(
    lastClose === undefined ? "n/a" : `${lastClose.date} close ${formatClose(lastClose.close)}`,
  );
  const latestSessionLabel = $derived(
    snapshot.ohlcv === undefined
      ? lastCloseLabel
      : `${snapshot.ohlcv.date} OHLC close ${formatClose(snapshot.ohlcv.close)}`,
  );

  const tiles = $derived(
    INDICATOR_TILES.flatMap((tile) => {
      const value = snapshot.indicators[tile.key];
      return value === undefined ? [] : [{ ...tile, value }];
    }),
  );

  const guideRows = $derived(
    GUIDE_KEYS.flatMap((guide) => {
      const value = snapshot.indicators[guide.key];
      return value === undefined ? [] : [{ ...guide, value }];
    }),
  );

  const shownHorizons = $derived(horizons.slice(0, MAX_HORIZON_TICKS));

  function markerForLastClose(): readonly SeriesMarker<Time>[] {
    if (lastClose === undefined) {
      return [];
    }

    return [
      {
        time: lastClose.date,
        position: "inBar",
        color: "#166e7d",
        shape: "circle",
        text: formatClose(lastClose.close),
      },
    ];
  }

  function updateChart(): void {
    if (chart === null || lineSeries === null) {
      return;
    }

    lineSeries.setData([...lineData]);
    seriesMarkers?.setMarkers([...markerForLastClose()]);
    chart.timeScale().fitContent();
  }

  onMount(() => {
    if (chartEl === undefined) {
      return;
    }

    chart = createChart(chartEl, {
      autoSize: true,
      height: CHART_HEIGHT,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#5c6066",
      },
      grid: {
        vertLines: { color: "#f0ede7" },
        horzLines: { color: "#f0ede7" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: "#d7e6e8",
      },
      timeScale: {
        borderColor: "#d7e6e8",
        timeVisible: false,
      },
    });

    lineSeries = chart.addSeries(LineSeries, {
      color: "#166e7d",
      lineWidth: 2,
      lastValueVisible: true,
      priceLineVisible: true,
    });

    for (const guide of guideRows) {
      lineSeries.createPriceLine({
        price: guide.value,
        color: "#c4942e",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: guide.label,
      });
    }

    seriesMarkers = createSeriesMarkers(lineSeries, []);
    observer = new ResizeObserver(() => chart?.timeScale().fitContent());
    observer.observe(chartEl);
    updateChart();

    return () => {
      observer?.disconnect();
      chart?.remove();
      chart = null;
      lineSeries = null;
      seriesMarkers = null;
    };
  });

  $effect(() => {
    updateChart();
  });
</script>

<div class="mt-3">
  <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
    <div class="font-mono text-[10.5px] text-[#5c6066]">
      {latestSessionLabel}
    </div>
    {#if shownHorizons.length > 0}
      <div class="flex flex-wrap gap-1.5">
        {#each shownHorizons as horizon}
          <span
            class="rounded border border-[#c9c4ba] bg-transparent px-1.75 py-0.5 font-mono text-[10px] text-[#8a8f96]"
          >
            +{horizon}td
          </span>
        {/each}
      </div>
    {/if}
  </div>

  <div
    bind:this={chartEl}
    class="h-[260px] w-full overflow-hidden rounded-md border border-border bg-card"
    role="img"
    aria-label="Interactive recent closes chart for {snapshot.symbol}"
  ></div>
</div>

{#if tiles.length > 0}
  <div class="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4 xl:grid-cols-7">
    {#each tiles as tile}
      <div class="rounded-md border border-border bg-secondary px-2.5 py-2">
        <div class="font-mono text-[12.5px] font-medium text-foreground">
          {formatClose(tile.value)}
        </div>
        <div class="mt-0.5 text-[9.5px] uppercase tracking-wider text-muted-foreground">
          {tile.label}
        </div>
      </div>
    {/each}
  </div>
{/if}
