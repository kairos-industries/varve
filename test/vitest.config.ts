import { defineConfig } from "vitest/config";

export default defineConfig({
  // Tests never use a search model the developer has installed; the ones that need one build their own.
  test: { env: { TEMPORAL_ATLAS_MODELS: "/nonexistent/temporal-atlas-models" } },
});
