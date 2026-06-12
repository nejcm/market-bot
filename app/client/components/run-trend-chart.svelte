<script lang="ts">
  import type { RunTrendPoint } from "../view-model";

  interface Props {
    readonly points: readonly RunTrendPoint[];
  }

  let { points }: Props = $props();

  const WIDTH = 720;
  const HEIGHT = 220;
  const PADDING_X = 28;
  const PADDING_TOP = 26;
  const PADDING_BOTTOM = 28;
  const BAR_GAP = 6;
  const MAX_BAR_WIDTH = 48;

  const plotWidth = WIDTH - PADDING_X * 2;
  const plotHeight = HEIGHT - PADDING_TOP - PADDING_BOTTOM;
  const baselineY = HEIGHT - PADDING_BOTTOM;

  const maxRuns = $derived(Math.max(1, ...points.map((point) => point.runs)));
  const bars = $derived(
    points.map((point, index) => {
      const slot = plotWidth / Math.max(1, points.length);
      const barWidth = Math.min(MAX_BAR_WIDTH, slot - BAR_GAP);
      const barHeight = (point.runs / maxRuns) * plotHeight;
      const x = PADDING_X + slot * index + (slot - barWidth) / 2;
      return {
        ...point,
        x,
        barWidth,
        barHeight,
        y: baselineY - barHeight,
        centerX: x + barWidth / 2,
        isLatest: index === points.length - 1,
      };
    }),
  );
</script>

{#if bars.length === 0}
  <div class="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
    No dated runs yet.
  </div>
{:else}
  <svg
    class="mt-3 h-[220px] w-full"
    viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
    role="img"
    aria-label="Runs per day"
  >
    <g stroke="currentColor" class="text-border">
      <line x1={PADDING_X} x2={WIDTH - PADDING_X} y1={baselineY} y2={baselineY} />
      <line
        x1={PADDING_X}
        x2={WIDTH - PADDING_X}
        y1={baselineY - plotHeight / 2}
        y2={baselineY - plotHeight / 2}
        opacity="0.55"
      />
      <line
        x1={PADDING_X}
        x2={WIDTH - PADDING_X}
        y1={PADDING_TOP}
        y2={PADDING_TOP}
        opacity="0.35"
      />
    </g>
    {#each bars as bar}
      <g>
        <title>{bar.runs} runs on {bar.date}</title>
        <rect
          x={bar.x}
          y={bar.y}
          width={bar.barWidth}
          height={Math.max(1, bar.barHeight)}
          rx="3"
          fill={bar.isLatest ? "#4ba3b2" : "#d7e6e8"}
        />
        <text
          x={bar.centerX}
          y={bar.y - 8}
          text-anchor="middle"
          class="fill-foreground text-[11px]"
        >
          {bar.runs}
        </text>
        <text
          x={bar.centerX}
          y={HEIGHT - 8}
          text-anchor="middle"
          class="fill-muted-foreground font-mono text-[10px]"
        >
          {bar.date.slice(5)}
        </text>
      </g>
    {/each}
  </svg>
{/if}
