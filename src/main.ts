import { createApp } from "vue";
import { createPinia } from "pinia";
import PrimeVue from "primevue/config";
import Aura from "@primevue/themes/aura";
import App from "./App.vue";
import BuildIdentityError from "./components/BuildIdentityError.vue";
import { verifyBuildIdentity } from "./domain/buildIdentity";
import "./assets/styles/main.css";

async function bootstrap() {
  try {
    await verifyBuildIdentity();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    createApp(BuildIdentityError, { message }).mount("#app");
    return;
  }

  createApp(App)
    .use(createPinia())
    .use(PrimeVue, {
      ripple: false,
      theme: {
        preset: Aura,
        options: { darkModeSelector: ".dark", cssLayer: false },
      },
    })
    .mount("#app");
}

void bootstrap();
