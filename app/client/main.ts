import { mount } from "svelte";
import App from "./app.svelte";

const target = document.querySelector("#app");

if (target === null) {
  throw new Error("Research Console root element not found");
}

mount(App, { target });
