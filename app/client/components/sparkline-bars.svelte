<script lang="ts">
  import type { RunWorkspaceSparklineGeometry } from "../run-workspace-view";

  interface Props {
    readonly geometry: RunWorkspaceSparklineGeometry;
    readonly label: string;
  }

  let { geometry, label }: Props = $props();

  const WIDTH = 100;
  const HEIGHT = 42;
  const VERTICAL_PADDING = 3;
  const PLOT_HEIGHT = HEIGHT - VERTICAL_PADDING * 2;
</script>

<svg
  class="block h-12 w-full overflow-visible"
  viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
  role="img"
  aria-label={label}
  preserveAspectRatio="none"
>
  <title>{label}</title>
  <line
    x1="0"
    x2={WIDTH}
    y1={VERTICAL_PADDING + geometry.baseline * PLOT_HEIGHT}
    y2={VERTICAL_PADDING + geometry.baseline * PLOT_HEIGHT}
    stroke="#d8d4cc"
    stroke-width="0.7"
  />
  {#each geometry.bars as bar}
    <rect
      x={bar.x * WIDTH}
      y={VERTICAL_PADDING + bar.y * PLOT_HEIGHT}
      width={bar.width * WIDTH}
      height={Math.max(0.8, bar.height * PLOT_HEIGHT)}
      rx="0.8"
      fill="#277f8d"
      opacity="0.82"
    />
  {/each}
</svg>
