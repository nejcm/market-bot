<script lang="ts">
  interface Props {
    readonly label: string;
    readonly value: string;
    readonly options: readonly string[];
    readonly onChange: (value: string) => void;
  }

  let { label, value, options, onChange }: Props = $props();
</script>

<label class="space-y-1">
  {#if label !== ""}
    <span class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
  {/if}
  <select
    class="h-8 w-full rounded-md border border-input bg-background px-2 text-sm shadow-xs outline-none transition focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
    {value}
    onchange={(event) => onChange(event.currentTarget.value)}
  >
    {#each options as option}
      <option value={option}>{option === "" ? "any" : option}</option>
    {/each}
  </select>
</label>
