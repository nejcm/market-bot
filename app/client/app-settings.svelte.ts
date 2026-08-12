// Only app/client/app.svelte may import this module. The SSR loader treats
// .svelte.ts as plain TypeScript, so importing it from run-workspace.svelte
// Would evaluate $state without Svelte's compiler transform.
import { loadAppSettings, saveAppSettings, type ReportDetail } from "./app-settings";

export const appSettings = $state(loadAppSettings());

export function setReportDetail(value: ReportDetail): void {
  appSettings.reportDetail = value;
  saveAppSettings(appSettings);
}

export function setShowSources(value: boolean): void {
  appSettings.showSources = value;
  saveAppSettings(appSettings);
}
