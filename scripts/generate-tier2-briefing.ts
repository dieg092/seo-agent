// scripts/generate-tier2-briefing.ts
import { writeFileSync } from "node:fs";
import { generateBriefing } from "../src/tier2/generateBriefing";

generateBriefing()
  .then((briefing) => {
    writeFileSync("tier2-briefing.md", briefing);
    console.log("Briefing Tier 2 escrito en tier2-briefing.md");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Briefing generation failed:", error);
    process.exit(1);
  });
