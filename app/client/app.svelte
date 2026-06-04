<script lang="ts">
  const title = "Research Console";
</script>

<main class="shell">
  <section class="intro" aria-labelledby="research-console-title">
    <p class="eyebrow">Market Bot</p>
    <h1 id="research-console-title">{title}</h1>
    <p>
      Run history, sourced research artifacts, analytics, and provider health will appear here
      as the console API phases are added.
    </p>
  </section>
</main>

<style>
  :global(:root) {
    color: #1d2522;
    background: #f3f0e8;
    font-family:
      "Aptos",
      "Segoe UI",
      system-ui,
      sans-serif;
    font-synthesis: none;
    text-rendering: optimizeLegibility;
  }

  :global(body) {
    min-width: 320px;
    min-height: 100vh;
    margin: 0;
    background:
      linear-gradient(90deg, rgba(29, 37, 34, 0.05) 1px, transparent 1px) 0 0 / 28px 28px,
      #f3f0e8;
  }

  :global(button),
  :global(input),
  :global(select) {
    font: inherit;
  }

  .shell {
    display: grid;
    min-height: 100vh;
    place-items: center;
    padding: 32px;
  }

  .intro {
    width: min(720px, 100%);
    border-top: 3px solid #1d2522;
    border-bottom: 1px solid rgba(29, 37, 34, 0.2);
    padding: 28px 0 32px;
  }

  .eyebrow {
    margin: 0 0 12px;
    color: #49645b;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    color: #111715;
    font-size: 48px;
    line-height: 1;
  }

  p {
    max-width: 560px;
    margin: 18px 0 0;
    color: #3b4843;
    font-size: 16px;
    line-height: 1.55;
  }

  @media (max-width: 640px) {
    .shell {
      padding: 20px;
    }

    h1 {
      font-size: 36px;
    }
  }
</style>
