<script lang="ts">
  import {
    closeLinePoints,
    formatClose,
    type SnapshotView,
  } from "../view-model";

  interface Props {
    readonly snapshot: SnapshotView;
    readonly horizons: readonly number[];
  }

  let { snapshot, horizons }: Props = $props();

  const WIDTH = 720;
  const HEIGHT = 240;
  const PADDING_LEFT = 56;
  const PADDING_RIGHT = 64;
  const PADDING_TOP = 18;
  const PADDING_BOTTOM = 28;
  const DATE_TICK_EVERY = 5;
  const MAX_HORIZON_TICKS = 4;

  const plotWidth = WIDTH - PADDING_LEFT - PADDING_RIGHT;
  const plotHeight = HEIGHT - PADDING_TOP - PADDING_BOTTOM;
  const baselineY = HEIGHT - PADDING_BOTTOM;

  const GUIDE_KEYS = [
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

  const points = $derived(
    closeLinePoints(snapshot.recentCloses, PADDING_LEFT, plotWidth, PADDING_TOP, plotHeight),
  );
  const pathData = $derived(
    points
      .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
      .join(" "),
  );
  const lastPoint = $derived(points.at(-1));
  const minClose = $derived(Math.min(...snapshot.recentCloses.map((entry) => entry.close)));
  const maxClose = $derived(Math.max(...snapshot.recentCloses.map((entry) => entry.close)));

  function yForValue(value: number): number | undefined {
    if (value < minClose || value > maxClose || maxClose === minClose) {
      return undefined;
    }

    return PADDING_TOP + ((maxClose - value) / (maxClose - minClose)) * plotHeight;
  }

  const guides = $derived(
    GUIDE_KEYS.flatMap((guide) => {
      const value = snapshot.indicators[guide.key];
      if (value === undefined) {
        return [];
      }

      const y = yForValue(value);
      return y === undefined ? [] : [{ ...guide, value, y }];
    }),
  );

  const dateTicks = $derived(
    points.filter(
      (_, index) => index % DATE_TICK_EVERY === 0 || index === points.length - 1,
    ),
  );

  const horizonTicks = $derived.by(() => {
    const last = points.at(-1);
    if (last === undefined || horizons.length === 0) {
      return [];
    }

    const shown = horizons.slice(0, MAX_HORIZON_TICKS);
    const maxHorizon = shown.at(-1) ?? 1;
    const extension = WIDTH - 8 - last.x;
    return shown.map((horizon) => ({
      horizon,
      x: last.x + (horizon / maxHorizon) * extension,
    }));
  });

  const tiles = $derived(
    INDICATOR_TILES.flatMap((tile) => {
      const value = snapshot.indicators[tile.key];
      return value === undefined ? [] : [{ ...tile, value }];
    }),
  );
</script>

<svg
  class="mt-3 h-[240px] w-full"
  viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
  role="img"
  aria-label="Recent closes for {snapshot.symbol}"
>
  <g stroke="currentColor" class="text-border">
    <line x1={PADDING_LEFT} x2={WIDTH - 8} y1={baselineY} y2={baselineY} />
    <line
      x1={PADDING_LEFT}
      x2={WIDTH - 8}
      y1={PADDING_TOP}
      y2={PADDING_TOP}
      opacity="0.35"
    />
  </g>
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
  {#each guides as guide}
    <line
      x1={PADDING_LEFT}
      x2={WIDTH - PADDING_RIGHT}
      y1={guide.y}
      y2={guide.y}
      stroke="#c4b389"
      stroke-dasharray="3 4"
      opacity="0.8"
    />
    <text
      x={WIDTH - PADDING_RIGHT + 4}
      y={guide.y + 3}
      class="fill-[#8a6116] font-mono text-[9.5px]"
    >
      {guide.label}
    </text>
  {/each}
  {#if pathData !== ""}
    <path d={pathData} fill="none" stroke="#4ba3b2" stroke-width="2.5" stroke-linecap="round" />
  {/if}
  {#if lastPoint !== undefined}
    <circle cx={lastPoint.x} cy={lastPoint.y} r="4" fill="#166e7d" />
    <text
      x={lastPoint.x}
      y={lastPoint.y - 9}
      text-anchor="middle"
      class="fill-foreground font-mono text-[10.5px] font-medium"
    >
      {formatClose(lastPoint.close)}
    </text>
  {/if}
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
  {#each horizonTicks as tick}
    <line
      x1={tick.x}
      x2={tick.x}
      y1={baselineY - 5}
      y2={baselineY + 5}
      stroke="#8a8f96"
    />
    <text
      x={tick.x}
      y={HEIGHT - 10}
      text-anchor="middle"
      class="fill-[#8a8f96] font-mono text-[9.5px]"
    >
      +{tick.horizon}td
    </text>
  {/each}
</svg>

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
