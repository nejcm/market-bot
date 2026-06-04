<script lang="ts">
  import * as Card from "$lib/components/ui/card";

  interface Props {
    readonly title: string;
    readonly value: string;
  }

  let { title, value }: Props = $props();
</script>

<Card.Card class="border-cyan-900/10 bg-card/90">
  <Card.CardHeader>
    <Card.CardTitle>{title}</Card.CardTitle>
  </Card.CardHeader>
  <Card.CardContent>
    <pre class="max-h-[620px] overflow-auto rounded-md bg-slate-950 p-4 text-xs text-cyan-50">{value}</pre>
  </Card.CardContent>
</Card.Card>
