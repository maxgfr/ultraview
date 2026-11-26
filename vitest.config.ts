import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "tests/fixtures/**"],
    // Builds index a fixture copy; never pull grammars over the network from a test.
    env: { CODEINDEX_NO_GRAMMARS_PULL: "1" },
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/vendor/**"],
      reporter: ["text-summary", "text"],
    },
  },
});
