<script lang="ts">
  interface Props {
    readonly symbol: string | undefined;
    readonly class?: string;
  }

  let { symbol, class: className = "" }: Props = $props();
  let failedSymbol = $state<string>();

  const url = $derived(
    symbol === undefined || symbol === ""
      ? undefined
      : `https://raw.githubusercontent.com/nvstly/icons/main/ticker_icons/${encodeURIComponent(symbol.toUpperCase())}.png`,
  );
</script>

{#if url !== undefined && failedSymbol !== symbol}
  <img
    src={url}
    alt=""
    loading="lazy"
    referrerpolicy="no-referrer"
    class="shrink-0 rounded-[4px] object-contain {className}"
    onerror={() => (failedSymbol = symbol)}
  />
{/if}
