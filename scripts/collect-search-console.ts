import { collectSearchConsole } from "../src/collectors/searchConsoleCollector";

collectSearchConsole()
  .then(({ inserted }) => {
    console.log(`Search Console: ${inserted} filas insertadas/actualizadas`);
    process.exit(0);
  })
  .catch((error) => {
    console.error("Search Console collector failed:", error);
    process.exit(1);
  });
