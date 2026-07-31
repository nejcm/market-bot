<script lang="ts">
  import type { Snippet } from "svelte";
  import { formatDateMinute, type WebSubjectProfileView } from "../view-model";

  interface Props {
    readonly profile: WebSubjectProfileView;
    readonly citeChips: Snippet<[readonly string[]]>;
    readonly bindSection: (key: string) => (el: HTMLElement) => void;
  }

  let { profile, citeChips, bindSection }: Props = $props();
</script>

<section {@attach bindSection("webSubjectProfile")} class="mt-8.5 scroll-mt-5">
  <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-[#d9c89a] pb-2">
    <span class="text-[11px] font-semibold uppercase tracking-[0.09em] text-[#8a6116]">
      Web Subject Profile
    </span>
    <span class="font-mono text-[10px] text-[#8a8f96]">
      low-trust web evidence
      {#if profile.generatedAt !== undefined}
        · {formatDateMinute(profile.generatedAt)}
      {/if}
    </span>
  </div>
  {#if profile.subjectLabel !== undefined}
    <div class="mt-3 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
      {profile.subjectLabel}
    </div>
  {/if}
  {#if profile.subjectSummary !== undefined}
    <div
      class="mt-3 rounded-lg border border-[#e9ddc2] bg-[#fbf6ea] px-4 py-3 text-[13px] leading-[1.55] text-[#4a4334]"
    >
      {profile.subjectSummary.answer}
      {@render citeChips(profile.subjectSummary.sourceIds)}
    </div>
  {/if}
  <div class="mt-3.5 grid gap-3 sm:grid-cols-2">
    {#each profile.questions as question}
      <div class="rounded-lg border border-border bg-card px-4 py-3.5">
        <div class="text-[12.5px] font-semibold text-foreground">
          {question.label}
        </div>
        <div class="mt-2 font-serif text-[13px] leading-[1.55] text-[#45494e]">
          {question.answer}
        </div>
        {@render citeChips(question.sourceIds)}
      </div>
    {/each}
  </div>
  {#if profile.recentMaterialEvents.length > 0}
    <div class="mt-4">
      <div class="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[#8a6116]">
        Recent material events
      </div>
      <div class="mt-2 space-y-2">
        {#each profile.recentMaterialEvents as event}
          <div
            class="rounded-lg border border-[#e9ddc2] bg-[#fbf6ea] px-4 py-2.5 text-[12.5px] text-[#4a4334]"
          >
            {event.claim}
            {@render citeChips(event.sourceIds)}
          </div>
        {/each}
      </div>
    </div>
  {/if}
  {#if profile.factLedger.length > 0}
    <div class="mt-4">
      <div class="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[#8a6116]">
        Fact ledger
      </div>
      <div class="mt-2 space-y-2">
        {#each profile.factLedger as fact}
          <div class="rounded-lg border border-border bg-card px-4 py-2.5 text-[12.5px] text-[#45494e]">
            {fact.claim}
            {@render citeChips(fact.sourceIds)}
          </div>
        {/each}
      </div>
    </div>
  {/if}
  {#if profile.openGaps.length > 0}
    <div class="mt-3 rounded-lg border border-dashed border-[#d9c89a] bg-[#fbf6ea] px-4 py-3">
      <div class="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[#8a6116]">
        Profile gaps
      </div>
      <div class="space-y-1 text-[12.5px] text-[#5c6066]">
        {#each profile.openGaps as gap}
          <div>{gap}</div>
        {/each}
      </div>
    </div>
  {/if}
</section>
