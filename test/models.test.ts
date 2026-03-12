import { describe, expect, it } from "vitest";
import { type ModelProvider, modelAliases, providers } from "../models.ts";

type ModelsDevModel = {
  name: string;
  status?: string;
  release_date?: string;
};

type ModelsDevProvider = {
  name: string;
  models: Record<string, ModelsDevModel>;
};

type ModelsDevApi = Record<string, ModelsDevProvider>;

const api = fetch("https://models.dev/api.json").then((r) => r.json() as Promise<ModelsDevApi>);

/** split a resolve slug into the models.dev provider key and model key */
function parseResolve(resolve: string): { provider: string; modelId: string } {
  const idx = resolve.indexOf("/");
  return { provider: resolve.slice(0, idx), modelId: resolve.slice(idx + 1) };
}

describe("models.dev validity", async () => {
  const data = await api;

  for (const alias of modelAliases) {
    const parsed = parseResolve(alias.resolve);

    it(`${alias.resolve} exists on models.dev`, () => {
      const providerData = data[parsed.provider];
      expect(providerData, `provider "${parsed.provider}" not found on models.dev`).toBeDefined();
      const model = providerData.models[parsed.modelId];
      expect(
        model,
        `model "${parsed.modelId}" not found under ${parsed.provider} on models.dev`
      ).toBeDefined();
    });

    it(`${alias.resolve} is not deprecated`, () => {
      const model = data[parsed.provider]?.models[parsed.modelId];
      if (!model) return; // covered by existence test above
      expect(model.status, `${alias.resolve} is deprecated on models.dev`).not.toBe("deprecated");
    });
  }
});

describe("latest model per provider snapshot", async () => {
  const data = await api;
  const providerKeys = Object.keys(providers) as ModelProvider[];

  const latestByProvider: Record<string, { modelId: string; releaseDate: string }> = {};

  for (const key of providerKeys) {
    const providerData = data[key];
    if (!providerData) continue;

    let latest: { modelId: string; releaseDate: string } | undefined;
    for (const [modelId, model] of Object.entries(providerData.models)) {
      if (model.status === "deprecated") continue;
      const rd = model.release_date;
      if (!rd) continue;
      if (!latest || rd > latest.releaseDate) {
        latest = { modelId, releaseDate: rd };
      }
    }
    if (latest) {
      latestByProvider[key] = latest;
    }
  }

  it("matches snapshot", () => {
    expect(latestByProvider).toMatchSnapshot();
  });
});
