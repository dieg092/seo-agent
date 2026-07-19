import { computeLinkSuggestions } from "../src/embeddings/computeLinkSuggestions";

computeLinkSuggestions()
  .then((result) => {
    console.log(`Sugerencias de enlace: ${result.created} nuevas, ${result.updated} actualizadas, ${result.dismissed} descartadas`);
    process.exit(0);
  })
  .catch((error) => {
    console.error("Link suggestion computation failed:", error);
    process.exit(1);
  });
