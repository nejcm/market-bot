<script lang="ts">
  import { Activity, AlertTriangle, Database, Gauge, LineChart, ShieldCheck } from "@lucide/svelte";
  import { Badge } from "$lib/components/ui/badge";
  import * as Card from "$lib/components/ui/card";
  import type { DashboardMetrics, RunTrendPoint } from "../view-model";
  import RunTrendChart from "./run-trend-chart.svelte";

  interface Props {
    readonly metrics: DashboardMetrics;
    readonly trend: readonly RunTrendPoint[];
  }

  let { metrics, trend }: Props = $props();

  const metricCards = $derived([
    {
      label: "Runs",
      value: String(metrics.totalRuns),
      detail: `${metrics.equityRuns} equity / ${metrics.cryptoRuns} crypto`,
      icon: Activity,
    },
    {
      label: "Sources",
      value: String(metrics.totalSources),
      detail: "Traceable evidence items",
      icon: Database,
    },
    {
      label: "Forecasts",
      value: String(metrics.totalForecasts),
      detail: "Observable predictions",
      icon: LineChart,
    },
    {
      label: "Data gaps",
      value: String(metrics.totalDataGaps),
      detail: "Known evidence limits",
      icon: AlertTriangle,
    },
  ]);
</script>

<section class="grid gap-3 xl:grid-cols-[1fr_360px]">
  <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
    {#each metricCards as card}
      {@const Icon = card.icon}
      <Card.Card class="border-cyan-900/10 bg-card/90 shadow-sm">
        <Card.CardHeader class="flex-row items-start justify-between space-y-0 pb-2">
          <div>
            <Card.CardDescription>{card.label}</Card.CardDescription>
            <Card.CardTitle class="text-2xl tabular-nums">{card.value}</Card.CardTitle>
          </div>
          <Icon class="size-4 text-cyan-700" />
        </Card.CardHeader>
        <Card.CardContent>
          <p class="text-xs text-muted-foreground">{card.detail}</p>
        </Card.CardContent>
      </Card.Card>
    {/each}
  </div>

  <Card.Card class="border-cyan-900/10 bg-card/90 shadow-sm">
    <Card.CardHeader class="flex-row items-start justify-between space-y-0 pb-2">
      <div>
        <Card.CardDescription>Coverage</Card.CardDescription>
        <Card.CardTitle class="flex items-center gap-2 text-2xl tabular-nums">
          {metrics.scoredRuns}
          <span class="text-sm font-normal text-muted-foreground">scored</span>
        </Card.CardTitle>
      </div>
      <Gauge class="size-4 text-cyan-700" />
    </Card.CardHeader>
    <Card.CardContent class="flex items-center justify-between gap-3">
      <Badge variant="outline" class="border-cyan-700/30 bg-cyan-100/70 text-cyan-900">
        <ShieldCheck class="size-3" />
        {metrics.averageConfidence} confidence
      </Badge>
      <span class="text-xs text-muted-foreground">Latest history snapshot</span>
    </Card.CardContent>
  </Card.Card>
</section>

<Card.Card class="mt-3 border-cyan-900/10 bg-card/90 shadow-sm">
  <Card.CardHeader class="pb-2">
    <Card.CardTitle>Run Trend</Card.CardTitle>
    <Card.CardDescription>Recent dated runs, forecasts, and evidence gaps.</Card.CardDescription>
  </Card.CardHeader>
  <Card.CardContent>
    <RunTrendChart points={trend} />
  </Card.CardContent>
</Card.Card>
