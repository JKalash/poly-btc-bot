import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PairDatasetHashMismatchError,
  PairDatasetPathError,
  buildPairDatasetManifest,
  canonicalPairDatasetJson,
  verifyPairDatasetManifest,
} from "../src/pair-dataset-manifest";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "b5p-pair-dataset-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("pair dataset manifest", () => {
  it("sorts and hashes artifacts into a byte-stable manifest", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "data"));
    await writeFile(join(root, "data", "events.jsonl"), "{\"id\":\"1\"}\n");
    await writeFile(join(root, "data", "checkpoints.json"), "[]\n");

    const input = {
      root,
      datasetId: "pair-fixture-v1",
      selection: { markets: ["market-b", "market-a"], fromMs: 100 },
      artifacts: [
        { path: "data/events.jsonl", role: "MARKET_EVENTS" as const },
        { path: "data/checkpoints.json", role: "BOOK_CHECKPOINTS" as const },
      ],
    };
    const first = await buildPairDatasetManifest(input);
    const second = await buildPairDatasetManifest({ ...input, artifacts: [...input.artifacts].reverse() });

    expect(first.artifacts.map(({ path }) => path)).toEqual([
      "data/checkpoints.json",
      "data/events.jsonl",
    ]);
    expect(canonicalPairDatasetJson(first)).toBe(canonicalPairDatasetJson(second));
    expect(first.datasetHash).toBe(second.datasetHash);
    const verified = await verifyPairDatasetManifest(root, first);
    expect(new TextDecoder().decode(verified.get("data/events.jsonl"))).toBe("{\"id\":\"1\"}\n");
  });

  it("rejects a file changed after manifest creation", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "events.jsonl"), "one\n");
    const manifest = await buildPairDatasetManifest({
      root,
      datasetId: "mutated",
      selection: {},
      artifacts: [{ path: "events.jsonl", role: "MARKET_EVENTS" }],
    });
    await writeFile(join(root, "events.jsonl"), "two\n");

    await expect(verifyPairDatasetManifest(root, manifest)).rejects.toBeInstanceOf(PairDatasetHashMismatchError);
  });

  it.each(["../outside.json", "/tmp/outside.json", "data/../outside.json", "data\\outside.json"])(
    "rejects unsafe artifact path %s",
    async (artifactPath) => {
      const root = await temporaryRoot();
      await expect(buildPairDatasetManifest({
        root,
        datasetId: "unsafe",
        selection: {},
        artifacts: [{ path: artifactPath, role: "MARKET_EVENTS" }],
      })).rejects.toBeInstanceOf(PairDatasetPathError);
    },
  );

  it("rejects a symlink that escapes the dataset root", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeFile(join(outside, "events.jsonl"), "[]\n");
    await symlink(join(outside, "events.jsonl"), join(root, "events.jsonl"));

    await expect(buildPairDatasetManifest({
      root,
      datasetId: "symlink-escape",
      selection: {},
      artifacts: [{ path: "events.jsonl", role: "MARKET_EVENTS" }],
    })).rejects.toBeInstanceOf(PairDatasetPathError);
  });
});
