export function assertNoSecretsInText(
  label: string,
  content: string,
  secrets: readonly string[],
): void {
  if (
    secrets.some((secret) =>
      [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)].some((value) =>
        content.includes(value),
      ),
    )
  ) {
    throw new Error(`Secret-like value leaked into ${label}`);
  }
}
