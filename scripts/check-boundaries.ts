import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export interface ImportReference { specifier: string; line: number }

const nodeBuiltins = new Set(builtinModules);

/** Includes type queries and re-exports, which regex-based import checks miss. */
export function importReferences(file: string, source: string): ImportReference[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const references: ImportReference[] = [];
  function visit(node: ts.Node): void {
    let value: ts.Node | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) value = node.moduleSpecifier;
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) value = node.argument.literal;
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) value = node.moduleReference.expression;
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) value = node.arguments[0];
    if (value && ts.isStringLiteralLike(value)) references.push({ specifier: value.text, line: ast.getLineAndCharacterOfPosition(value.getStart(ast)).line + 1 });
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return references;
}

function localTarget(file: string, specifier: string): string | undefined {
  if (specifier.startsWith("@/")) return path.posix.normalize(specifier.slice(2));
  if (specifier.startsWith(".")) return path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
}

export function boundaryViolations(file: string, source: string): string[] {
  const shared = file.startsWith("src/shared/");
  const client = file.startsWith("src/client/") || file.startsWith("app/components/") || /^\s*["']use client["'];/u.test(source);
  const production = /^(app|src)\//u.test(file);
  return importReferences(file, source).flatMap(({ specifier, line }) => {
    const target = localTarget(file, specifier);
    let reason: string | undefined;
    if (shared && target && !target.startsWith("src/shared/")) reason = "shared must not depend on upper layers";
    else if (client && target && /^(src\/(server|cli)|app\/api)(\/|$)/u.test(target)) reason = "client must not depend on server or CLI";
    else if (file.startsWith("src/server/") && target?.startsWith("src/cli/")) reason = "server must not depend on CLI";
    else if (production && target && /^(tests|scripts)(\/|$)/u.test(target)) reason = "production must not depend on tests or tooling";
    else if ((shared || client) && (specifier.startsWith("node:") || nodeBuiltins.has(specifier))) reason = "browser-compatible layers must not import Node modules";
    return reason ? [`${file}:${line}: ${reason}: ${specifier}`] : [];
  });
}

export function checkBoundaries(root: string): string[] {
  const files: string[] = [];
  function walk(directory: string): void {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (/\.[cm]?[jt]sx?$/u.test(file)) files.push(file);
    }
  }
  walk("src"); walk("app");
  const errors: string[] = [];
  const edges = new Map<string, string[]>();
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    errors.push(...boundaryViolations(file, source));
    edges.set(file, importReferences(file, source).flatMap(({ specifier }) => {
      const target = localTarget(file, specifier);
      if (!target) return [];
      const resolved = [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`, `${target}/index.tsx`].find(candidate => files.includes(candidate));
      if (!resolved && /\.(css|json|svg|woff2)$/u.test(target) && fs.existsSync(path.join(root, target))) return [];
      if (!resolved) errors.push(`${file}: unresolved local import: ${specifier}`);
      return resolved ? [resolved] : [];
    }));
  }
  const done = new Set<string>();
  const active: string[] = [];
  function visit(file: string): void {
    if (active.includes(file)) { errors.push(`Import cycle (including types): ${[...active.slice(active.indexOf(file)), file].join(" -> ")}`); return; }
    if (done.has(file)) return;
    active.push(file);
    for (const target of edges.get(file) ?? []) visit(target);
    active.pop(); done.add(file);
  }
  for (const file of files) visit(file);
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const errors = checkBoundaries(process.cwd());
  if (errors.length) { process.stderr.write(`${errors.join("\n")}\n`); process.exitCode = 1; }
  else process.stdout.write("Import boundaries and cycles checked.\n");
}
