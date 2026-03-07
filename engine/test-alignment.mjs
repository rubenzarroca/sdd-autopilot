// Test: TOOLS array ↔ HANDLER_MAP alignment in index.ts
// Detects ghost tools, orphan handlers, broken imports, and duplicates.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

// Prevent MCP server from starting on import
process.env.SDD_SKIP_MAIN = "1";

import { TOOLS, HANDLER_MAP } from "./build/index.js";

// Import handler source modules to verify exports exist
import * as handlers from "./build/handlers.js";
import * as observability from "./build/observability.js";
import * as metacognition from "./build/metacognition.js";

// Collect all exported functions from the three source modules
const allExports = {
  ...handlers,
  ...observability,
  ...metacognition,
};

describe("Tool alignment", () => {
  after(() => process.exit(0));

  it("Check 1: No hay tools fantasma (TOOLS entry sin HANDLER_MAP key)", () => {
    const ghosts = TOOLS
      .map((t) => t.name)
      .filter((name) => !(name in HANDLER_MAP));

    assert.deepStrictEqual(
      ghosts,
      [],
      ghosts
        .map(
          (name) =>
            `Tool fantasma detectado: '${name}' está expuesto al cliente pero no tiene handler asignado`,
        )
        .join("\n"),
    );
  });

  it("Check 2: No hay handlers huérfanos (HANDLER_MAP key sin TOOLS entry)", () => {
    const toolNames = new Set(TOOLS.map((t) => t.name));
    const orphans = Object.keys(HANDLER_MAP).filter(
      (name) => !toolNames.has(name),
    );

    assert.deepStrictEqual(
      orphans,
      [],
      orphans
        .map(
          (name) =>
            `Handler huérfano detectado: '${name}' tiene handler pero no está expuesto al cliente`,
        )
        .join("\n"),
    );
  });

  it("Check 3: No hay imports rotos (handler referencia función inexistente)", () => {
    const broken = [];
    for (const [name, fn] of Object.entries(HANDLER_MAP)) {
      const found = Object.values(allExports).some(
        (exp) => typeof exp === "function" && exp === fn,
      );
      if (!found) {
        broken.push(name);
      }
    }

    assert.deepStrictEqual(
      broken,
      [],
      broken
        .map(
          (name) =>
            `Import roto detectado: handler para '${name}' referencia una función que no existe`,
        )
        .join("\n"),
    );
  });

  it("Check 4: No hay duplicados en TOOLS ni HANDLER_MAP", () => {
    const toolNames = TOOLS.map((t) => t.name);
    const toolDupes = toolNames.filter(
      (name, i) => toolNames.indexOf(name) !== i,
    );

    assert.deepStrictEqual(
      toolDupes,
      [],
      `Nombres duplicados en TOOLS: ${[...new Set(toolDupes)].join(", ")}`,
    );

    // JS object keys are inherently unique (last-write-wins),
    // so this is more of a sanity check
    const handlerKeys = Object.keys(HANDLER_MAP);
    const handlerDupes = handlerKeys.filter(
      (name, i) => handlerKeys.indexOf(name) !== i,
    );

    assert.deepStrictEqual(
      handlerDupes,
      [],
      `Keys duplicadas en HANDLER_MAP: ${[...new Set(handlerDupes)].join(", ")}`,
    );
  });
});
