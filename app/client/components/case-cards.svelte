<script lang="ts">
  import type { Snippet } from "svelte";
  import type { RunWorkspaceCaseKey, RunWorkspaceCaseSection } from "../run-workspace-view";

  interface Props {
    readonly items: readonly RunWorkspaceCaseSection[];
    readonly sectionKey: string;
    readonly citeChips: Snippet<[readonly string[]]>;
    readonly bindSection: (key: string) => (el: HTMLElement) => void;
  }

  let { items, sectionKey, citeChips, bindSection }: Props = $props();

  const CASE_STYLES: Readonly<Record<RunWorkspaceCaseKey, { readonly edge: string; readonly fg: string }>> = {
    bullCase: { edge: "#0F9D58", fg: "#0F9D58" },
    bearCase: { edge: "#9B0F06", fg: "#9B0F06" },
    risks: { edge: "#c4b389", fg: "#8a6116" },
    catalysts: { edge: "#9fc2c8", fg: "#166e7d" },
  };

  const caseSections = $derived(
    items.map((section) => ({
      ...section,
      ...CASE_STYLES[section.key],
    })),
  );
</script>

<div {@attach bindSection(sectionKey)} class="mt-8.5 grid scroll-mt-5 gap-3.5 sm:grid-cols-2">
  {#each caseSections as section}
    <div
      class="rounded-lg border border-border bg-card px-4.5 py-4"
      style="border-top: 3px solid {section.edge}"
    >
      <div class="text-xs font-semibold uppercase tracking-wider" style="color: {section.fg}">
        {section.title}
      </div>
      <div class="mt-3 flex flex-col gap-3">
        {#each section.items as item}
          <div class="min-w-0">
            <span class="font-serif text-sm leading-[1.55] text-[#2a2d30]">
              {item.text}
            </span>
            {@render citeChips(item.sourceIds)}
          </div>
        {/each}
      </div>
    </div>
  {/each}
</div>
