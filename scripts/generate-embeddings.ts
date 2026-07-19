// scripts/generate-embeddings.ts
import { generateEmbeddings } from "../src/embeddings/generateEmbeddings";

generateEmbeddings()
  .then((result) => {
    console.log(`Embeddings: ${result.embedded} generados/actualizados, ${result.skippedUnchanged} sin cambios`);
    process.exit(0);
  })
  .catch((error) => {
    console.error("Embedding generation failed:", error);
    process.exit(1);
  });
