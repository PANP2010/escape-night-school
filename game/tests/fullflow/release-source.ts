/** Syntax inspection only: never evaluates product modules or invokes the type checker. */
import ts from 'typescript';
import { posix } from 'node:path';

export const parse = (file: string, text: string) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
export function nodes(root: ts.Node | undefined): ts.Node[] {
  if (!root) return [];
  const out: ts.Node[] = [];
  const visit = (n: ts.Node) => { out.push(n); ts.forEachChild(n, visit); };
  visit(root); return out;
}
export const nameOf = (n: ts.Node | undefined): string => n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : '';
export const variable = (sf: ts.SourceFile, name: string): ts.VariableDeclaration | undefined => {
  for (const s of sf.statements) if (ts.isVariableStatement(s) && s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
    const found = s.declarationList.declarations.find(d => nameOf(d.name) === name);
    if (found) return found;
  }
  return undefined;
};
export const method = (sf: ts.SourceFile, name: string) => nodes(sf).find((n): n is ts.MethodDeclaration => ts.isMethodDeclaration(n) && nameOf(n.name) === name);
export const fn = (sf: ts.SourceFile, name: string) => nodes(sf).find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && nameOf(n.name) === name);
export const literal = (root: ts.Node | undefined, value: string) => nodes(root).some(n => ts.isStringLiteral(n) && n.text === value);
export const property = (root: ts.Node | undefined, name: string) => nodes(root).some(n => ts.isPropertyAccessExpression(n) && n.name.text === name);
export const call = (root: ts.Node | undefined, name: string) => nodes(root).some(n => ts.isCallExpression(n) &&
  (ts.isIdentifier(n.expression) ? n.expression.text === name : ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === name));
export const assignedLiteral = (root: ts.Node | undefined, key: string, value: string) => nodes(root).some(n =>
  ts.isPropertyAssignment(n) && nameOf(n.name) === key && ts.isStringLiteral(n.initializer) && n.initializer.text === value);
export const comparedLiteral = (root: ts.Node | undefined, key: string, value: string) => nodes(root).some(n =>
  ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
  ts.isPropertyAccessExpression(n.left) && n.left.name.text === key && ts.isStringLiteral(n.right) && n.right.text === value);
export const imported = (sf: ts.SourceFile, local: string) => {
  for (const s of sf.statements) if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
    const bindings = s.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const e of bindings.elements) if (e.name.text === local)
      return { module: s.moduleSpecifier.text, exported: e.propertyName?.text ?? local };
  }
  return undefined;
};
/** Follow this.method() calls so extracted helpers remain inspectable, without running them. */
export function methodNodes(sf: ts.SourceFile, name: string): ts.Node[] {
  const seen = new Set<string>(), out: ts.Node[] = [];
  const visit = (key: string) => {
    if (seen.has(key)) return; seen.add(key);
    const body = method(sf, key)?.body;
    if (!body) return;
    const ns = nodes(body); out.push(...ns);
    for (const n of ns) if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.kind === ts.SyntaxKind.ThisKeyword)
      visit(n.expression.name.text);
  };
  visit(name); return out;
}
/** Follow only declared union branches and relative shared type imports, with no module evaluation. */
export async function messageShapes(file: string, name: string, load: (file: string) => Promise<ts.SourceFile>, seen = new Set<string>()): Promise<ts.TypeLiteralNode[]> {
  const key = `${file}:${name}`; if (seen.has(key)) return []; seen.add(key);
  const sf = await load(file), decl = sf.statements.find(s => (ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)) && s.name.text === name);
  if (!decl) {
    const binding = imported(sf, name);
    if (!binding?.module.startsWith('.')) return [];
    const target = posix.normalize(posix.join(posix.dirname(file), binding.module));
    return target.startsWith('shared/') ? messageShapes(target, binding.exported, load, seen) : [];
  }
  if (ts.isInterfaceDeclaration(decl)) return [ts.factory.createTypeLiteralNode(decl.members)];
  if (!ts.isTypeAliasDeclaration(decl)) return [];
  const expand = async (n: ts.TypeNode): Promise<ts.TypeLiteralNode[]> => {
    if (ts.isTypeLiteralNode(n)) return [n];
    if (ts.isUnionTypeNode(n)) return (await Promise.all(n.types.map(expand))).flat();
    return ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName) ? messageShapes(file, n.typeName.text, load, seen) : [];
  };
  return expand(decl.type);
}
export { ts };
