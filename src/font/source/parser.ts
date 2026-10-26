import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_GLYPH_WIDTH } from "./hangul.ts";
import { type PlistObject, type PlistValue, parseSourcePlist, sourceObject } from "./pretendard.ts";

const MAX_COMPONENT_DEPTH = 10;
export interface ParsedContour {
  pathData: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

interface Node {
  x: number;
  y: number;
  type: string;
}
interface ParsedGlyph {
  shapes: ParsedContour[];
  width: number;
  unicode: number;
}
interface ParseContext {
  active: Set<string>;
  results: Map<string, ParsedGlyph>;
  interpolation?: readonly GlyphInterpolationMaster[];
}

export interface GlyphInterpolationMaster {
  layerId: string;
  factor: number;
}

function nodesToSvgPath(nodes: Node[]): string {
  const startIdx = nodes.findIndex((node) => node.type !== "o");
  if (startIdx < 0) throw new Error("A contour needs an explicit on-curve point");
  const first = nodes[startIdx]!;
  const parts = [`M${first.x} ${-first.y}`];
  const n = nodes.length;
  let index = (startIdx + 1) % n;
  let consumed = 0;
  while (consumed < n - 1) {
    const node = nodes[index]!;
    if (node.type === "o") {
      const next = nodes[(index + 1) % n]!;
      if (next.type === "o") {
        const end = nodes[(index + 2) % n]!;
        if (!["c", "cs", "s"].includes(end.type))
          throw new Error("Two cubic control points must end at a curve node");
        parts.push(`C${node.x} ${-node.y} ${next.x} ${-next.y} ${end.x} ${-end.y}`);
        index = (index + 3) % n;
        consumed += 3;
      } else {
        if (!["q", "qs"].includes(next.type))
          throw new Error("A single quadratic control point must end at a quadratic node");
        parts.push(`Q${node.x} ${-node.y} ${next.x} ${-next.y}`);
        index = (index + 2) % n;
        consumed += 2;
      }
    } else {
      if (["c", "cs", "s", "q", "qs"].includes(node.type))
        throw new Error("Curve endpoint has no preceding control points");
      parts.push(`L${node.x} ${-node.y}`);
      index = (index + 1) % n;
      consumed++;
    }
  }
  return parts.join("") + "Z";
}

function numericPair(
  value: PlistValue | undefined,
  fallback: [number, number],
  context: string,
): [number, number] {
  if (value === undefined) return fallback;
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value.some((n) => typeof n !== "number" || !Number.isFinite(n))
  )
    throw new Error(`${context}: expected two finite numbers`);
  return value as [number, number];
}

/**
 * Strictly parse a single master; backgrounds and other masters never contribute contours.
 * Geometry metadata is the control-point bounds (not analytic Bézier extrema), retained
 * to preserve calibrated region masks and source fingerprints.
 */
export function parseGlyphFile(content: string, layerId: string, glyphsDir: string): ParsedGlyph {
  return parse(content, layerId, glyphsDir, 0, { active: new Set(), results: new Map() });
}

/** Interpolate source nodes and component transforms before expanding components. */
export function parseInterpolatedGlyphFile(
  content: string,
  masters: readonly GlyphInterpolationMaster[],
  glyphsDir: string,
): ParsedGlyph {
  if (
    masters.length < 2 ||
    new Set(masters.map((master) => master.layerId)).size !== masters.length ||
    masters.some((master) => !master.layerId || !Number.isFinite(master.factor) || master.factor <= 0) ||
    Math.abs(masters.reduce((sum, master) => sum + master.factor, 0) - 1) > 1e-12
  )
    throw new Error("Interpolation needs distinct masters with positive finite factors summing to one");
  return parse(content, "instance", glyphsDir, 0, {
    active: new Set(),
    results: new Map(),
    interpolation: masters,
  });
}

function masterLayer(layers: PlistObject[], layerId: string, name: string): PlistObject {
  const matches = layers.filter((layer) => layer.layerId === layerId);
  if (matches.length !== 1)
    throw new Error(`${name}: expected exactly one master layer '${layerId}', found ${matches.length}`);
  return matches[0]!;
}

function nodeKind(type: PlistValue | undefined): string | undefined {
  if (typeof type !== "string") return undefined;
  return type === "ls" ? "l" : ["cs", "s"].includes(type) ? "c" : type === "qs" ? "q" : type;
}

function interpolatedLayer(
  layers: PlistObject[],
  masters: readonly GlyphInterpolationMaster[],
  name: string,
): PlistObject {
  // Dated backup layers are harmless. Active intermediate/alternate layers require a
  // full Glyphs variation model and must never be silently ignored.
  if (
    layers.some(
      (layer) =>
        layer.attributes !== undefined || (typeof layer.name === "string" && /[[{]/.test(layer.name)),
    )
  )
    throw new Error(`${name}: intermediate or alternate layers are unsupported for interpolation`);
  const selected = masters.map((master) => masterLayer(layers, master.layerId, name));
  const sum = (values: number[]): number =>
    values.reduce((value, coordinate, index) => value + coordinate * masters[index]!.factor, 0);
  const widths = selected.map((layer) => layer.width ?? DEFAULT_GLYPH_WIDTH);
  if (widths.some((width) => typeof width !== "number" || !Number.isFinite(width) || width <= 0))
    throw new Error(`${name}: invalid advance width`);
  const shapes = selected.map((layer) => {
    if (!Array.isArray(layer.shapes)) throw new Error(`${name}: missing master shapes for interpolation`);
    return layer.shapes.map((shape) => sourceObject(shape, `${name} shape`));
  });
  if (shapes.some((entries) => entries.length !== shapes[0]!.length))
    throw new Error(`${name}: incompatible contour counts across interpolation masters`);
  const result = shapes[0]!.map((first, index): PlistObject => {
    const entries = shapes.map((entries) => entries[index]!);
    if (first.ref !== undefined) {
      if (entries.some((entry) => entry.ref !== first.ref))
        throw new Error(`${name}: incompatible component references across interpolation masters`);
      for (const entry of entries)
        for (const key of ["angle", "transform", "rotation", "slant", "smartComponentValues", "piece"])
          if (entry[key] !== undefined && entry[key] !== 0)
            throw new Error(`${name}: unsupported component ${key}; refusing to guess geometry`);
      const positions = entries.map((entry) => numericPair(entry.pos, [0, 0], `${name} component position`));
      const scales = entries.map((entry) => numericPair(entry.scale, [1, 1], `${name} component scale`));
      if (scales.some(([sx, sy]) => !sx || !sy)) throw new Error(`${name}: zero component scale`);
      return {
        ...first,
        pos: [sum(positions.map((pair) => pair[0])), sum(positions.map((pair) => pair[1]))],
        scale: [sum(scales.map((pair) => pair[0])), sum(scales.map((pair) => pair[1]))],
      };
    }
    if (entries.some((entry) => entry.ref !== undefined || entry.closed !== 1 || !Array.isArray(entry.nodes)))
      throw new Error(`${name}: incompatible or open contour across interpolation masters`);
    const contours = entries.map((entry) => entry.nodes as PlistValue[]);
    if (contours.some((nodes) => nodes.length !== contours[0]!.length))
      throw new Error(`${name}: incompatible node counts across interpolation masters`);
    const nodes = contours[0]!.map((_, nodeIndex) => {
      const points = contours.map((nodes) => nodes[nodeIndex]);
      if (
        points.some(
          (point) =>
            !Array.isArray(point) ||
            point.length !== 3 ||
            typeof point[0] !== "number" ||
            typeof point[1] !== "number" ||
            !Number.isFinite(point[0]) ||
            !Number.isFinite(point[1]),
        )
      )
        throw new Error(`${name}: malformed interpolation node`);
      const tuples = points as [number, number, string][];
      if (tuples.some((point) => nodeKind(point[2]) !== nodeKind(tuples[0]![2])))
        throw new Error(`${name}: incompatible node types across interpolation masters`);
      return [sum(tuples.map((point) => point[0])), sum(tuples.map((point) => point[1])), tuples[0]![2]];
    });
    return { ...first, nodes };
  });
  return { ...selected[0]!, width: sum(widths as number[]), shapes: result };
}

function parse(
  content: string,
  layerId: string,
  glyphsDir: string,
  depth: number,
  context: ParseContext,
): ParsedGlyph {
  if (depth > MAX_COMPONENT_DEPTH)
    throw new Error(`Component reference depth exceeds ${MAX_COMPONENT_DEPTH}`);
  const root = parseSourcePlist(content);
  const name = String(root.glyphname ?? "unnamed glyph");
  const rawUnicode = Array.isArray(root.unicode) ? root.unicode[0] : root.unicode;
  const unicode = typeof rawUnicode === "number" ? rawUnicode : 0;
  if (!Array.isArray(root.layers)) throw new Error(`${name}: missing layers`);
  const layers = root.layers.map((value) => sourceObject(value, `${name} layer`));
  const layer = context.interpolation
    ? interpolatedLayer(layers, context.interpolation, name)
    : masterLayer(layers, layerId, name);
  const width = layer.width === undefined ? DEFAULT_GLYPH_WIDTH : layer.width;
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0)
    throw new Error(`${name}: invalid advance width`);
  if (!Array.isArray(layer.shapes)) throw new Error(`${name}: missing shapes in master '${layerId}'`);
  const componentShapes: ParsedContour[] = [];
  const inlineShapes: ParsedContour[] = [];
  for (const value of layer.shapes) {
    const shape = sourceObject(value, `${name} shape`);
    if (shape.ref !== undefined) {
      const ref = shape.ref;
      if (typeof ref !== "string" || !/^[\w.-]+$/.test(ref))
        throw new Error(`${name}: invalid component reference`);
      for (const key of ["angle", "transform", "rotation", "slant", "smartComponentValues", "piece"])
        if (shape[key] !== undefined && shape[key] !== 0)
          throw new Error(`${name}: unsupported component ${key}; refusing to guess geometry`);
      const [dx, dy] = numericPair(shape.pos, [0, 0], `${name} component position`);
      const [sx, sy] = numericPair(shape.scale, [1, 1], `${name} component scale`);
      if (!sx || !sy) throw new Error(`${name}: zero component scale`);
      let path = "";
      let refContent: string | undefined;
      for (const file of [`${ref}.glyph`, `${ref}_.glyph`]) {
        try {
          path = resolve(glyphsDir, file);
          refContent = readFileSync(path, "utf8");
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (refContent === undefined)
        throw new Error(
          `${name}: missing referenced component '${ref}' in ${join(glyphsDir, ref + ".glyph")}`,
        );
      const key = `${path}::${layerId}`;
      if (context.active.has(key)) throw new Error(`${name}: circular component reference '${ref}'`);
      let result = context.results.get(key);
      if (!result) {
        context.active.add(key);
        try {
          result = parse(refContent, layerId, glyphsDir, depth + 1, context);
          context.results.set(key, result);
        } finally {
          context.active.delete(key);
        }
      }
      for (const contour of result.shapes) {
        const xs = [contour.minX * sx + dx, contour.maxX * sx + dx];
        const ys = [contour.minY * sy + dy, contour.maxY * sy + dy];
        componentShapes.push({
          ...contour,
          pathData: contour.pathData.replace(
            /(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s+(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi,
            (_, x, y) => `${Number(x) * sx + dx} ${Number(y) * sy - dy}`,
          ),
          minX: Math.min(...xs),
          maxX: Math.max(...xs),
          minY: Math.min(...ys),
          maxY: Math.max(...ys),
          cx: contour.cx * sx + dx,
          cy: contour.cy * sy + dy,
          w: contour.w * Math.abs(sx),
          h: contour.h * Math.abs(sy),
        });
      }
      continue;
    }
    if (shape.closed !== 1) throw new Error(`${name}: unsupported open contour`);
    if (!Array.isArray(shape.nodes) || shape.nodes.length < 2)
      throw new Error(`${name}: contour needs at least two nodes`);
    const nodes = shape.nodes.map((entry): Node => {
      if (
        !Array.isArray(entry) ||
        entry.length !== 3 ||
        typeof entry[0] !== "number" ||
        typeof entry[1] !== "number" ||
        !Number.isFinite(entry[0]) ||
        !Number.isFinite(entry[1]) ||
        typeof entry[2] !== "string" ||
        !["l", "ls", "o", "c", "cs", "s", "q", "qs"].includes(entry[2])
      )
        throw new Error(`${name}: unsupported or malformed contour node ${JSON.stringify(entry)}`);
      return { x: entry[0], y: entry[1], type: entry[2] };
    });
    let pathData: string;
    try {
      pathData = nodesToSvgPath(nodes);
    } catch (error) {
      throw new Error(`${name}: ${(error as Error).message}`);
    }
    const xs = nodes.map((node) => node.x),
      ys = nodes.map((node) => node.y);
    const minX = Math.min(...xs),
      maxX = Math.max(...xs),
      minY = Math.min(...ys),
      maxY = Math.max(...ys);
    inlineShapes.push({
      pathData,
      minX,
      maxX,
      minY,
      maxY,
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      w: maxX - minX,
      h: maxY - minY,
    });
  }
  return { shapes: [...componentShapes, ...inlineShapes], width, unicode };
}
