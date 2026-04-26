import fs from "node:fs/promises";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

async function main() {
  const [inputArg, outputArg] = process.argv.slice(2);

  if (!inputArg) {
    console.error("Usage: node scripts/svg-to-png.mjs <input.svg> [output.png]");
    process.exitCode = 1;
    return;
  }

  const inputPath = path.resolve(inputArg);
  const outputPath = path.resolve(
    outputArg ?? inputPath.replace(/\.svg$/i, ".png"),
  );

  if (!inputPath.toLowerCase().endsWith(".svg")) {
    console.error(`Input must be an .svg file: ${inputPath}`);
    process.exitCode = 1;
    return;
  }

  const svg = await fs.readFile(inputPath);
  const resvg = new Resvg(svg);
  const pngData = resvg.render().asPng();

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, pngData);

  console.log(`Wrote ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
