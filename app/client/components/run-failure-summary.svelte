<script lang="ts">
  import type { FailedRunArtifactFailure } from "../../types";

  interface Props {
    readonly failure: FailedRunArtifactFailure | undefined;
  }

  let { failure }: Props = $props();
</script>

{#if failure === undefined}
  <article class="mt-6 rounded-lg border border-red-200 bg-red-50 px-5 py-5">
    <div class="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-red-700">
      Failed Run Artifact
    </div>
    <h1 class="mt-1 text-xl font-semibold tracking-tight">Failure diagnostics unavailable</h1>
    <p class="mt-2 text-sm leading-relaxed text-[#45494e]">
      failure.json marks this run complete, but its diagnostics could not be read. Inspect the Files tab for the raw artifact.
    </p>
  </article>
{:else}
  <article class="mt-6 overflow-hidden rounded-lg border border-red-200 bg-card">
    <div class="border-b border-red-100 bg-red-50 px-5 py-4">
      <div class="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-red-700">
        Failed Run Artifact
      </div>
      <h1 class="mt-1 text-xl font-semibold tracking-tight">
        {failure.phase === "post-synthesis"
          ? "Post-synthesis stage failed"
          : "Final synthesis did not validate"}
      </h1>
      {#if failure.message !== undefined}
        <p class="mt-2 text-sm leading-relaxed text-[#45494e]">{failure.message}</p>
      {/if}
      {#if failure.stack !== undefined}
        <pre class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-[#45494e]">{failure.stack}</pre>
      {/if}
    </div>

    {#if failure.totalCalls !== undefined || failure.reportRepairReprompts !== undefined || failure.cost !== undefined}
      <div class="grid gap-px border-b border-border bg-border sm:auto-cols-fr sm:grid-flow-col">
        {#each [
          ...(failure.totalCalls === undefined
            ? []
            : [["Final-synthesis calls", String(failure.totalCalls)]]),
          ...(failure.reportRepairReprompts === undefined
            ? []
            : [["Repair reprompts", String(failure.reportRepairReprompts)]]),
          ...(failure.cost?.tokenEstimate === undefined
            ? []
            : [["Token estimate", failure.cost.tokenEstimate.toLocaleString()]]),
          ...(failure.cost?.costEstimateUsd === undefined
            ? []
            : [["Estimated cost", `$${failure.cost.costEstimateUsd.toFixed(4)}`]]),
        ] as stat}
          <div class="bg-card px-4 py-3">
            <div class="font-mono text-sm font-medium">{stat[1]}</div>
            <div class="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              {stat[0]}
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <div class="grid gap-6 px-5 py-5 lg:grid-cols-2">
      <section>
        {#if failure.reportValidationErrors !== undefined}
          <h2 class="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
            Report validator errors
          </h2>
          {#if failure.reportValidationErrors.length > 0}
            <ul class="mt-2.5 list-disc space-y-2 pl-4 text-sm leading-relaxed">
              {#each failure.reportValidationErrors as error}
                <li>{error}</li>
              {/each}
            </ul>
          {:else}
            <p class="mt-2.5 text-sm text-muted-foreground">No report validator errors recorded.</p>
          {/if}
        {/if}

        {#if failure.predictionErrors !== undefined}
          <h2 class="mt-5 text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
            Prediction validator errors
          </h2>
          {#if failure.predictionErrors.length > 0}
            <ul class="mt-2.5 list-disc space-y-2 pl-4 text-sm leading-relaxed">
              {#each failure.predictionErrors as error}
                <li>{error}</li>
              {/each}
            </ul>
          {:else}
            <p class="mt-2.5 text-sm text-muted-foreground">No prediction validator errors recorded.</p>
          {/if}
        {/if}
      </section>

      <section>
        {#if failure.languageViolations !== undefined}
          <h2 class="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
            Language violation attribution
          </h2>
          {#if failure.languageViolations.length > 0}
            <div class="mt-2.5 space-y-2">
              {#each failure.languageViolations as violation}
                <div class="rounded-md border border-border bg-secondary px-3 py-2 text-sm">
                  <span class="font-mono text-xs font-semibold">{violation.field}</span>
                  <span class="text-muted-foreground"> matched </span>
                  <span class="font-mono text-xs">{violation.match}</span>
                </div>
              {/each}
            </div>
          {:else}
            <p class="mt-2.5 rounded-md border border-border bg-secondary px-3 py-2 text-sm">
              Attributed to assembly output, not the draft.
            </p>
          {/if}
        {/if}

        {#if failure.evidenceQuality !== undefined}
          <h2 class="mt-5 text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
            Evidence quality assessment
          </h2>
          <div class="mt-2.5 flex items-baseline gap-2">
            <span class="font-mono text-base font-semibold uppercase">{failure.evidenceQuality.label}</span>
            <span class="text-xs text-muted-foreground">
              rubric {failure.evidenceQuality.rubricVersion}
            </span>
          </div>
          {#if failure.evidenceQuality.limitingReasons.length > 0}
            <p class="mt-2 text-xs leading-relaxed text-[#5c6066]">
              Limits: {failure.evidenceQuality.limitingReasons.join("; ")}
            </p>
          {/if}
          {#if failure.evidenceQuality.advisoryReasons.length > 0}
            <p class="mt-1.5 text-xs leading-relaxed text-[#5c6066]">
              Advisories: {failure.evidenceQuality.advisoryReasons.join("; ")}
            </p>
          {/if}
          <div class="mt-3 space-y-1.5">
            {#each failure.evidenceQuality.checks as check}
              <div class="rounded-md border border-border px-3 py-2 text-xs">
                <div class="flex items-center justify-between gap-3">
                  <span class="font-mono font-semibold">{check.capability}</span>
                  <span class={check.passed ? "text-emerald-700" : "text-red-700"}>
                    {check.passed ? "pass" : "fail"}
                  </span>
                </div>
                <div class="mt-1 text-muted-foreground">
                  {check.evidenceClass} · coverage {check.coverage} · freshness {check.freshness} · corroboration {check.corroboration}
                </div>
                {#if check.reasons.length > 0}
                  <div class="mt-1 text-muted-foreground">{check.reasons.join("; ")}</div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </section>
    </div>
  </article>
{/if}
