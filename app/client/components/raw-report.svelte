<script lang="ts">
  interface Props {
    readonly label: string;
    readonly markdown: string;
  }

  let { label, markdown }: Props = $props();
</script>

<details class="group mt-3.5 overflow-hidden rounded-lg border border-border bg-card">
  <summary
    class="flex cursor-pointer list-none items-center justify-between gap-3 px-4.5 py-3 text-xs font-semibold transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
  >
    {label}
    <span class="font-mono text-[10.5px] font-normal text-muted-foreground">
      <span class="group-open:hidden">show markdown ›</span>
      <span class="hidden group-open:inline">hide ‹</span>
    </span>
  </summary>
  <div class="overflow-x-auto bg-[#16181a] px-5 py-4.5">
    <pre class="font-mono text-xs leading-relaxed text-[#c7cdd4]">{markdown}</pre>
  </div>
</details>
