#!/usr/bin/env node
import("tsx/esm/api").then(tsx => {
  tsx.register();
  import("../src/cli.ts");
});
