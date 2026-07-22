<script lang="ts">
  import type { RunWorkspacePeerImpliedRangeGeometry } from "../run-workspace-view";

  interface Props {
    readonly geometry: RunWorkspacePeerImpliedRangeGeometry;
    readonly label: string;
    readonly lowLabel: string;
    readonly midLabel: string;
    readonly highLabel: string;
    readonly currentLabel: string;
  }

  let { geometry, label, lowLabel, midLabel, highLabel, currentLabel }: Props = $props();

  const LEFT = 8;
  const WIDTH = 84;
</script>

<div>
  <svg class="block h-15 w-full overflow-visible" viewBox="0 0 100 54" role="img" aria-label={label}>
    <title>{label}</title>
    <line x1={LEFT} x2={LEFT + WIDTH} y1="28" y2="28" stroke="#c4d8dc" stroke-width="5" />
    <line
      x1={LEFT + geometry.mid * WIDTH}
      x2={LEFT + geometry.mid * WIDTH}
      y1="20"
      y2="36"
      stroke="#277f8d"
      stroke-width="1.4"
    />
    <path
      d={`M ${String(LEFT + geometry.current * WIDTH - 3.5)} 12 L ${String(LEFT + geometry.current * WIDTH + 3.5)} 12 L ${String(LEFT + geometry.current * WIDTH)} 19 Z`}
      fill="#1f2225"
    />
    <line
      x1={LEFT + geometry.current * WIDTH}
      x2={LEFT + geometry.current * WIDTH}
      y1="18"
      y2="38"
      stroke="#1f2225"
      stroke-width="1.4"
    />
  </svg>
  <div class="grid grid-cols-3 font-mono text-[9px] text-[#737980]">
    <span>{lowLabel}</span>
    <span class="text-center">{midLabel}</span>
    <span class="text-right">{highLabel}</span>
  </div>
  <div class="mt-1 text-center font-mono text-[10px] font-medium text-foreground">
    {currentLabel}
  </div>
</div>
