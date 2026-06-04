<script lang="ts">
  import * as Chart from "$lib/components/ui/chart";
  import type { RunTrendPoint } from "../view-model";

  interface Props {
    readonly points: readonly RunTrendPoint[];
  }

  let { points }: Props = $props();

  const width = 720;
  const height = 220;
  const padding = 28;
  const maxValue = $derived(
    Math.max(1, ...points.map((point) => point.runs + point.forecasts + point.dataGaps)),
  );
  const chartPoints = $derived(
    points.map((point, index) => {
      const x =
        points.length <= 1
          ? width / 2
          : padding + (index * (width - padding * 2)) / (points.length - 1);
      const total = point.runs + point.forecasts + point.dataGaps;
      const y = height - padding - (total / maxValue) * (height - padding * 2);
      return { ...point, total, x, y };
    }),
  );
  const pathData = $derived(
    chartPoints
      .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
      .join(" "),
  );
</script>

<Chart.Container
  class="h-[220px] w-full overflow-hidden rounded-md border border-cyan-900/10 bg-cyan-50/40"
  config={{
    runs: { label: "Runs", color: "var(--chart-1)" },
    forecasts: { label: "Forecasts", color: "var(--chart-2)" },
  }}
>
  {#if chartPoints.length === 0}
    <div class="flex h-full items-center justify-center text-sm text-muted-foreground">
      No dated runs yet.
    </div>
  {:else}
    <svg class="h-full w-full" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Run trend">
      <defs>
        <linearGradient id="run-trend-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="var(--chart-1)" stop-opacity="0.26" />
          <stop offset="100%" stop-color="var(--chart-1)" stop-opacity="0.02" />
        </linearGradient>
      </defs>
      <g stroke="currentColor" class="text-border">
        <line x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} />
        <line x1={padding} x2={width - padding} y1={height / 2} y2={height / 2} opacity="0.55" />
        <line x1={padding} x2={width - padding} y1={padding} y2={padding} opacity="0.35" />
      </g>
      {#if pathData !== ""}
        <path
          d={`${pathData} L ${chartPoints.at(-1)?.x ?? padding} ${height - padding} L ${chartPoints[0]?.x ?? padding} ${height - padding} Z`}
          fill="url(#run-trend-fill)"
        />
        <path d={pathData} fill="none" stroke="var(--chart-1)" stroke-width="3" stroke-linecap="round" />
      {/if}
      {#each chartPoints as point}
        <g>
          <circle cx={point.x} cy={point.y} r="4" fill="var(--chart-2)" />
          <text x={point.x} y={height - 8} text-anchor="middle" class="fill-muted-foreground text-[10px]">
            {point.date.slice(5)}
          </text>
          <text x={point.x} y={point.y - 10} text-anchor="middle" class="fill-foreground text-[11px]">
            {point.total}
          </text>
        </g>
      {/each}
    </svg>
  {/if}
</Chart.Container>
