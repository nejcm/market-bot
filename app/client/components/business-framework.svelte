<script lang="ts">
  import type { Snippet } from "svelte";
  import type { BusinessFrameworkView } from "../view-model";
  import type { RunWorkspaceSectionKey } from "../run-workspace-view";

  interface Props {
    readonly framework: BusinessFrameworkView;
    readonly citeChips: Snippet<[readonly string[]]>;
    readonly bindSection: (key: RunWorkspaceSectionKey) => (el: HTMLElement) => void;
  }

  let { framework, citeChips, bindSection }: Props = $props();
</script>

<section {@attach bindSection("businessFramework")} class="mt-8.5 scroll-mt-5">
  <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-[#cfe0e3] pb-2">
    <span class="text-[11px] font-semibold uppercase tracking-[0.09em] text-primary">
      Business framework
    </span>
    <span class="font-mono text-[10px] text-[#8a8f96]">
      phase · {framework.phase}
    </span>
  </div>
  <div class="mt-3.5 grid gap-3 sm:grid-cols-2">
    {#each framework.sections as section}
      <div class="rounded-lg border border-border bg-card px-4 py-3.5">
        <div class="flex flex-wrap items-center gap-2">
          {#if section.name !== "Phase"}
            <span
              class="rounded border border-[#cfe0e3] bg-accent px-1.75 py-0.5 font-mono text-[10px] text-primary"
            >
              {section.posture.replaceAll("-", " ")}
            </span>
          {/if}
          <div class="text-[12.5px] font-semibold text-foreground">
            {section.name}
          </div>
        </div>
        <div class="mt-2 font-serif text-[13px] leading-[1.55] text-[#45494e]">
          {section.text ?? section.summary}
        </div>
        {#if section.metrics.length > 0}
          <div class="mt-3 grid grid-cols-2 gap-2">
            {#each section.metrics.slice(0, 4) as metric}
              <div class="rounded-md border border-border bg-secondary px-2.5 py-2">
                <div class="font-mono text-[12px] font-medium text-foreground">
                  {metric.value}
                </div>
                <div class="mt-0.5 text-[9.5px] uppercase tracking-wider text-muted-foreground">
                  {metric.label}
                </div>
              </div>
            {/each}
          </div>
        {/if}
        {@render citeChips(section.sourceIds)}
        {#if section.gaps.length > 0}
          <div class="mt-2 space-y-1 font-mono text-[10px] leading-normal text-[#8a6116]">
            {#each section.gaps as gap}
              <div>{gap}</div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>
  {#if framework.gaps.length > 0}
    <div class="mt-3 rounded-lg border border-dashed border-[#d9c89a] bg-[#fbf6ea] px-4 py-3">
      <div class="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[#8a6116]">
        Framework data gaps
      </div>
      <div class="space-y-1 text-[12.5px] text-[#5c6066]">
        {#each framework.gaps as gap}
          <div>{gap}</div>
        {/each}
      </div>
    </div>
  {/if}
</section>
