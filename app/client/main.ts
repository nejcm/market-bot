import { mount } from "svelte";
import App from "./app.svelte";
// oxlint-disable-next-line import/no-unassigned-import
import "./app.css";

const target = document.querySelector("#app");

if (target === null) {
  throw new Error("Research Console App root element not found");
}

mount(App, { target });
