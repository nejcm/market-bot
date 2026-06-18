<script lang="ts">
  import { Input } from "$lib/components/ui/input";
  import {
    ASSET_CLASS_OPTIONS,
    CONSOLE_JOB_TYPES,
    DEPTH_OPTIONS,
    jobSupportsAsset,
    jobSupportsDepth,
  } from "../../../src/cli/job-registry";
  import type { ConsoleJob, ConsoleJobState } from "../../types";
  import { formatDateMinute } from "../view-model";
  import type { JobFormField, JobFormState } from "./console-types";
  import SelectField from "./select-field.svelte";

  interface Props {
    readonly jobs: readonly ConsoleJob[];
    readonly jobForm: JobFormState;
    readonly onJobFormChange: (field: JobFormField, value: string) => void;
    readonly onSubmitJob: () => void;
  }

  let { jobs, jobForm, onJobFormChange, onSubmitJob }: Props = $props();

  let openJobIds = $state<readonly string[]>([]);

  const STATUS_STYLES: Record<ConsoleJobState, { dot: string; fg: string; pulse: boolean }> = {
    queued: { dot: "#9aa1a8", fg: "#8a8f96", pulse: false },
    running: { dot: "#4ba3b2", fg: "#166e7d", pulse: true },
    succeeded: { dot: "#1e2226", fg: "#1a1c1e", pulse: false },
    failed: { dot: "#c4942e", fg: "#8a6116", pulse: false },
  };

  function toggleJob(jobId: string): void {
    openJobIds = openJobIds.includes(jobId)
      ? openJobIds.filter((id) => id !== jobId)
      : [...openJobIds, jobId];
  }

  function jobDetail(job: ConsoleJob): string {
    return job.argv.join(" ");
  }
</script>

<div class="mx-auto max-w-255" data-screen-label="Jobs">
  <h1 class="text-xl font-semibold tracking-tight">Jobs</h1>
  <div class="mt-1 text-[12.5px] text-[#5c6066]">
    Queue research jobs and watch their output. Table polls live.
  </div>

  <form
    class="mt-4.5 flex flex-wrap items-end gap-2.5 rounded-lg border border-border bg-card px-4.5 py-4"
    onsubmit={(event) => {
      event.preventDefault();
      onSubmitJob();
    }}
  >
    <div class="min-w-32">
      <SelectField
        label="Job type"
        value={jobForm.jobType}
        options={CONSOLE_JOB_TYPES}
        onChange={(value) => onJobFormChange("jobType", value)}
      />
    </div>
    {#if jobSupportsAsset(jobForm.jobType)}
      <div class="min-w-32">
        <SelectField
          label="Asset class"
          value={jobForm.assetClass}
          options={ASSET_CLASS_OPTIONS}
          onChange={(value) => onJobFormChange("assetClass", value)}
        />
      </div>
    {/if}
    {#if jobForm.jobType === "market-overview"}
      <label class="space-y-1">
        <span class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
          Horizon
        </span>
        <Input
          class="h-8 w-24 bg-background font-mono text-xs"
          value={jobForm.horizonTradingDays}
          type="number"
          min="1"
          max="20"
          oninput={(event) => onJobFormChange("horizonTradingDays", event.currentTarget.value)}
        />
      </label>
    {/if}
    {#if jobForm.jobType === "ticker"}
      <label class="space-y-1">
        <span class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
          Symbol
        </span>
        <Input
          class="h-8 w-36 bg-background font-mono text-xs"
          value={jobForm.symbol}
          placeholder="e.g. AAPL"
          oninput={(event) => onJobFormChange("symbol", event.currentTarget.value)}
        />
      </label>
    {/if}
    {#if jobForm.jobType === "research"}
      <label class="space-y-1">
        <span class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
          Subject
        </span>
        <Input
          class="h-8 w-48 bg-background text-xs"
          value={jobForm.subject}
          placeholder="e.g. AI biotech"
          oninput={(event) => onJobFormChange("subject", event.currentTarget.value)}
        />
      </label>
    {/if}
    {#if jobSupportsDepth(jobForm.jobType)}
      <div class="min-w-32">
        <SelectField
          label="Depth"
          value={jobForm.depth}
          options={DEPTH_OPTIONS}
          onChange={(value) => onJobFormChange("depth", value)}
        />
      </div>
    {/if}
    <button
      class="ml-auto whitespace-nowrap rounded-md bg-primary px-4.5 py-2 text-[12.5px] font-semibold text-primary-foreground transition hover:bg-[#135f6c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      type="submit"
    >
      Queue job
    </button>
  </form>

  <div class="mt-3.5 overflow-x-auto rounded-lg border border-border bg-card" aria-live="polite">
    <div class="min-w-180">
      <div
        class="grid grid-cols-[150px_minmax(0,1fr)_110px_130px] gap-3.5 border-b border-border bg-secondary px-4.5 py-2.5 font-mono text-[10px] tracking-[0.08em] text-muted-foreground"
      >
        <div>JOB ID</div>
        <div>DETAIL</div>
        <div>STATUS</div>
        <div>STARTED</div>
      </div>
      {#if jobs.length === 0}
        <div class="px-4.5 py-6 text-sm text-muted-foreground">No jobs queued yet.</div>
      {/if}
      {#each jobs as job (job.id)}
        {@const style = STATUS_STYLES[job.status]}
        {@const isOpen = openJobIds.includes(job.id)}
        <button
          class="grid w-full grid-cols-[150px_minmax(0,1fr)_110px_130px] items-center gap-3.5 border-b border-[#f0ede7] px-4.5 py-2.75 text-left transition hover:bg-[#f8f6f2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {isOpen
            ? 'bg-[#f8f6f2]'
            : 'bg-transparent'}"
          type="button"
          aria-expanded={isOpen}
          onclick={() => toggleJob(job.id)}
        >
          <span class="truncate font-mono text-[11.5px] text-[#5c6066]" title={job.id}>
            {job.id}
          </span>
          <span class="min-w-0">
            <span class="block truncate text-xs text-[#1f2225]">{job.label}</span>
            <span class="block truncate font-mono text-[10.5px] text-muted-foreground">
              {jobDetail(job)}
            </span>
          </span>
          <span class="flex items-center gap-1.75">
            <span
              class="size-1.75 rounded-full {style.pulse ? 'animate-pulse' : ''}"
              style="background: {style.dot}"
            ></span>
            <span class="font-mono text-[11px]" style="color: {style.fg}">{job.status}</span>
          </span>
          <span class="font-mono text-[11px] text-muted-foreground">
            {job.startedAt === undefined ? "—" : formatDateMinute(job.startedAt)}
          </span>
        </button>
        {#if isOpen}
          <div class="border-b border-[#f0ede7] bg-[#16181a] px-5 py-3.5">
            {#if job.outputRunPath !== undefined}
              <div class="mb-2 font-mono text-[10.5px] text-[#6e757d]">{job.outputRunPath}</div>
            {/if}
            <pre
              class="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-[#c7cdd4]">{job.stdout ===
              ""
                ? "(no output yet)"
                : job.stdout}</pre>
            {#if job.stderr !== ""}
              <pre
                class="mt-2.5 whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-[#d9b36a]">{job.stderr}</pre>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  </div>
</div>
