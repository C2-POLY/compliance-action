import { isAlias, parseDocument, visit } from 'yaml';

/**
 * The only YAML parser of the action. Strict on purpose: YAML 1.2 core schema, a single document,
 * no `%` directive, no tag, no anchor, no alias (so no merge keys, no custom types, no expansion).
 * Throws an Error whose message is one line.
 */
export function parseStrict(text: string): unknown {
  const doc = parseDocument(text, { version: '1.2', schema: 'core', uniqueKeys: true, strict: true, prettyErrors: false });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) throw new Error(problem.message.split('\n')[0]);
  if (doc.directives.yaml.explicit) throw new Error('a %YAML directive is not allowed');
  if (Object.keys(doc.directives.tags).some((k) => k !== '!' && k !== '!!')) throw new Error('a %TAG directive is not allowed');
  let found: string | undefined;
  visit(doc, {
    Node(_key, node) {
      if (isAlias(node)) found = 'aliases';
      else if (node.tag) found = `the tag ${node.tag}`;
      else if (node.anchor) found = 'anchors';
      return found ? visit.BREAK : undefined;
    },
  });
  if (found) throw new Error(`${found} ${found === 'aliases' || found === 'anchors' ? 'are' : 'is'} not allowed`);
  return doc.toJS({ maxAliasCount: 0 });
}
