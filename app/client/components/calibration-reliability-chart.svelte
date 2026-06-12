<script lang="ts">
  import type { ReliabilityBin } from "../view-model";

  interface Props {
    readonly bins: readonly ReliabilityBin[];
  }

  let { bins }: Props = $props();

  const WIDTH = 720;
  const HEIGHT = 260;
  const PADDING_LEFT = 46;
  const PADDING_RIGHT = 18;
  const PADDING_TOP = 22;
  const PADDING_BOTTOM = 34;
  const BAR_INSET = 4;

  const plotWidth = WIDTH - PADDING_LEFT - PADDING_RIGHT;
  const plotHeight = HEIGHT - PADDING_TOP - PADDING_BOTTOM;
  const baselineY = HEIGHT - PADDING_BOTTOM;

  function xScale(probability: number): number {
    return PADDING_LEFT + probability * plotWidth;
  }

  function yScale(hitRate: number): number {
    return baselineY - hitRate * plotHeight;
  }

  const bars = $derived(
    bins.map((bin) => {
      const x = xScale(bin.pLow) + BAR_INSET;
      const width = Math.max(2, xScale(bin.pHigh) - xScale(bin.pLow) - BAR_INSET * 2);
      return {
        ...bin,
        x,
        width,
        y: yScale(bin.hitRate),
        height: Math.max(1, baselineY - yScale(bin.hitRate)),
        centerX: x + width / 2,
      };
    }),
  );

  const AXIS_TICKS = [0, 0.25, 0.5, 0.75, 1];
</script>

{#if bars.length === 0}
  <div class="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
    No reliability bins yet.
  </div>
{:else}
  <svg
    class="mt-3 h-[260px] w-full"
    viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
    role="img"
    aria-label="Reliability: stated probability vs observed hit rate"
  >
    <g stroke="currentColor" class="text-border">
      {#each AXIS_TICKS as tick}
        <line
          x1={PADDING_LEFT}
          x2={WIDTH - PADDING_RIGHT}
          y1={yScale(tick)}
          y2={yScale(tick)}
          opacity={tick === 0 ? 1 : 0.45}
        />
      {/each}
    </g>
    {#each AXIS_TICKS as tick}
      <text
        x={PADDING_LEFT - 8}
        y={yScale(tick) + 3}
        text-anchor="end"
        class="fill-muted-foreground font-mono text-[10px]"
      >
        {tick.toFixed(2)}
      </text>
      <text
        x={xScale(tick)}
        y={HEIGHT - 12}
        text-anchor="middle"
        class="fill-muted-foreground font-mono text-[10px]"
      >
        {tick.toFixed(2)}
      </text>
    {/each}
    <line
      x1={xScale(0)}
      y1={yScale(0)}
      x2={xScale(1)}
      y2={yScale(1)}
      stroke="#c4b389"
      stroke-dasharray="5 4"
    />
    <text
      x={xScale(0.78)}
      y={yScale(0.78) - 8}
      text-anchor="middle"
      class="fill-[#8a6116] font-mono text-[10px]"
      transform={`rotate(-19 ${xScale(0.78)} ${yScale(0.78) - 8})`}
    >
      perfect calibration
    </text>
    {#each bars as bar}
      <g>
        <title>
          {bar.label}: {bar.hitCount}/{bar.totalCount} hit ({Math.round(bar.hitRate * 100)}%)
        </title>
        <rect
          x={bar.x}
          y={bar.y}
          width={bar.width}
          height={bar.height}
          rx="3"
          fill="#4ba3b2"
          opacity="0.82"
        />
        <text
          x={bar.centerX}
          y={bar.y - 7}
          text-anchor="middle"
          class="fill-foreground font-mono text-[10px]"
        >
          n={bar.totalCount}
        </text>
      </g>
    {/each}
    <text
      x={PADDING_LEFT + plotWidth / 2}
      y={HEIGHT - 1}
      text-anchor="middle"
      class="fill-[#a8acb1] font-mono text-[9.5px]"
    >
      stated probability
    </text>
    <text
      x={12}
      y={PADDING_TOP + plotHeight / 2}
      text-anchor="middle"
      class="fill-[#a8acb1] font-mono text-[9.5px]"
      transform={`rotate(-90 12 ${PADDING_TOP + plotHeight / 2})`}
    >
      observed hit rate
    </text>
  </svg>
{/if}
