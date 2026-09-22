// Keywords the structured-output API rejects, checked before a request is made.
//
// A modality field was added to the research schema with minItems and maxItems on its array. Both are ordinary JSON Schema and neither is accepted: the API answers 400 with "For 'array' type, property 'maxItems' is not supported". Nothing local caught it, because the schema is only ever seen by the API, so the first thing that noticed was a scheduled research run and a backfill that died eighteen seconds in.
//
// This fails the same mistake at the top of the run with the path to the offending keyword, rather than after a round trip, and it states the constraint where the next person editing a schema will see it.

const UNSUPPORTED = ["minItems", "maxItems", "minLength", "maxLength", "pattern", "minimum", "maximum", "format"];

/** Throws on the first unsupported keyword, naming where it sits. */
export function assertSupported(schema, where = "schema") {
  const walk = (node, path) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
    for (const k of Object.keys(node)) {
      if (UNSUPPORTED.includes(k)) {
        throw new Error(
          `${where}: ${path}.${k} is not supported by the structured-output API. ` +
          `State the constraint in the field's description and enforce it in code instead.`,
        );
      }
      walk(node[k], `${path}.${k}`);
    }
  };
  walk(schema, "");
  return schema;
}
