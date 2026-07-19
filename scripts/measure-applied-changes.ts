// scripts/measure-applied-changes.ts
import { measureAppliedChanges } from "../src/graduation/measureImpact";

measureAppliedChanges()
  .then((result) => {
    console.log(
      `Medición de impacto: ${result.measured} cambios medidos, ${result.graduated.length} categorías graduadas${result.graduated.length > 0 ? ` (${result.graduated.join(", ")})` : ""}`
    );
    process.exit(0);
  })
  .catch((error) => {
    console.error("Impact measurement failed:", error);
    process.exit(1);
  });
