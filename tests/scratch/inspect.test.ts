import { describe, it } from "vitest";
import { DemoProvider } from "@/lib/provider/demo";
import { SAMPLE_MATERIAL } from "@/sample/material";

// Scratch inspection harness (not an assertion test): run with
//   npx vitest run tests/scratch/inspect.test.ts
describe("inspect demo provider output", () => {
  it("prints concepts and questions for the bundled sample", async () => {
    const provider = new DemoProvider();
    const out = await provider.generate(SAMPLE_MATERIAL);
    console.log("TITLE:", out.title);
    console.log("QUALITY:", JSON.stringify(out.quality, null, 2));
    console.log("\nCONCEPTS:");
    for (const c of out.concepts) {
      console.log(`- [${c.importance.toFixed(2)}] ${c.name}`);
      console.log(`    desc: ${c.description.slice(0, 110)}`);
    }
    console.log(`\nQUESTIONS (${out.questions.length}):`);
    for (const q of out.questions) {
      console.log(`\n=== [${q.type}] ${q.conceptName} (${q.difficulty})`);
      if (q.type === "mcq") {
        console.log(q.prompt);
        for (const o of q.options) console.log(`  ${o.id === q.correctOptionId ? "*" : " "} ${o.id}: ${o.text.slice(0, 90)}`);
      } else if (q.type === "truefalse") {
        console.log(q.prompt, "\n  stmt:", q.statement.slice(0, 120), "\n  answer:", q.correctAnswer);
      } else if (q.type === "short") {
        console.log(q.prompt.slice(0, 220), "\n  answer:", q.acceptedAnswers.join(" | "));
      } else {
        console.log(q.prompt.slice(0, 160), "\n  keyTerms:", q.keyTerms.join(", "));
      }
      console.log("  expl:", q.explanation.slice(0, 140));
    }
    console.log("\nDROPPED:", JSON.stringify(out.dropped));
    console.log("REJECTED:", JSON.stringify(out.rejected, null, 2).slice(0, 2000));
  }, 60_000);
});
