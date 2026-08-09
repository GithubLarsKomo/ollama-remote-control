import { useMemo } from 'react';
import {
  appendDirective,
  directiveNodes,
  parseKeyValueArgument,
  parseTextArgument,
  removeDirective,
  replaceKeyValueArgument,
  replaceTextArgument,
} from '@orc/core/modelfile-editor';
import {
  parseModelfile,
  replaceDirectiveArgument,
  type ModelfileDiagnostic,
  type ModelfileDirectiveName,
  type ModelfileDirectiveNode,
  type ParsedModelfile,
} from '@orc/core/modelfile-parser';

interface StructuredModelfileEditorProps {
  readonly raw: string;
  readonly disabled: boolean;
  readonly onChange: (nextRaw: string) => void;
}

type SimpleDirectiveName = Extract<ModelfileDirectiveName, 'FROM' | 'DRAFT' | 'RENDERER' | 'PARSER' | 'REQUIRES'>;

function diagnosticLabel(diagnostic: ModelfileDiagnostic): string {
  return `L${diagnostic.range.start.line}:${diagnostic.range.start.column} · ${diagnostic.code} · ${diagnostic.message}`;
}

function safePatch(
  apply: () => { readonly raw: string },
  onChange: (nextRaw: string) => void,
): void {
  try { onChange(apply().raw); } catch { /* parser diagnostics keep raw editing available */ }
}

function defaultSimpleArgument(name: SimpleDirectiveName): string {
  if (name === 'FROM') return 'model:latest';
  if (name === 'DRAFT') return 'draft-model:latest';
  if (name === 'RENDERER') return 'renderer-name';
  if (name === 'PARSER') return 'parser-name';
  return 'ollama >= 0.0.0';
}

function SimpleDirective({
  parsed,
  name,
  disabled,
  onChange,
}: {
  readonly parsed: ParsedModelfile;
  readonly name: SimpleDirectiveName;
  readonly disabled: boolean;
  readonly onChange: (nextRaw: string) => void;
}) {
  const nodes = directiveNodes(parsed, name);
  return (
    <section className="structured-directive-card">
      <div className="structured-directive-heading">
        <h5>{name}</h5>
        {nodes.length === 0 ? (
          <button
            className="secondary-button"
            disabled={disabled}
            onClick={() => safePatch(() => appendDirective(parsed, name, defaultSimpleArgument(name)), onChange)}
            type="button"
          >
            Add {name}
          </button>
        ) : null}
      </div>
      {nodes.length === 0 ? <p className="muted">Not present.</p> : nodes.map((node) => (
        <div className="structured-directive-row" key={node.id}>
          <input
            disabled={disabled || !node.structuredEditable}
            onChange={(event) => safePatch(() => replaceDirectiveArgument(parsed, node.id, event.target.value), onChange)}
            value={node.argument}
          />
          <button
            className="secondary-button"
            disabled={disabled || !node.structuredEditable}
            onClick={() => safePatch(() => removeDirective(parsed, node.id), onChange)}
            type="button"
          >
            Remove
          </button>
        </div>
      ))}
    </section>
  );
}

function AdapterDirectives({ parsed, disabled, onChange }: {
  readonly parsed: ParsedModelfile;
  readonly disabled: boolean;
  readonly onChange: (nextRaw: string) => void;
}) {
  const nodes = directiveNodes(parsed, 'ADAPTER');
  return (
    <section className="structured-directive-card">
      <div className="structured-directive-heading">
        <h5>ADAPTER</h5>
        <button
          className="secondary-button"
          disabled={disabled}
          onClick={() => safePatch(() => appendDirective(parsed, 'ADAPTER', 'adapter:latest'), onChange)}
          type="button"
        >
          Add adapter
        </button>
      </div>
      {nodes.length === 0 ? <p className="muted">No adapters.</p> : nodes.map((node) => (
        <div className="structured-directive-row" key={node.id}>
          <input
            disabled={disabled || !node.structuredEditable}
            onChange={(event) => safePatch(() => replaceDirectiveArgument(parsed, node.id, event.target.value), onChange)}
            value={node.argument}
          />
          <button
            className="secondary-button"
            disabled={disabled || !node.structuredEditable}
            onClick={() => safePatch(() => removeDirective(parsed, node.id), onChange)}
            type="button"
          >Remove</button>
        </div>
      ))}
    </section>
  );
}

function KeyValueDirectives({
  parsed,
  name,
  disabled,
  onChange,
}: {
  readonly parsed: ParsedModelfile;
  readonly name: 'PARAMETER' | 'MESSAGE';
  readonly disabled: boolean;
  readonly onChange: (nextRaw: string) => void;
}) {
  const nodes = directiveNodes(parsed, name);
  return (
    <section className="structured-directive-card">
      <div className="structured-directive-heading">
        <h5>{name}</h5>
        <button
          className="secondary-button"
          disabled={disabled}
          onClick={() => safePatch(
            () => appendDirective(parsed, name, name === 'PARAMETER' ? 'num_ctx 8192' : 'user New message'),
            onChange,
          )}
          type="button"
        >
          Add {name === 'PARAMETER' ? 'parameter' : 'message'}
        </button>
      </div>
      {nodes.length === 0 ? <p className="muted">None.</p> : nodes.map((node) => {
        const pair = parseKeyValueArgument(node.argument);
        const editable = node.structuredEditable && Boolean(pair);
        return (
          <div className="structured-key-value" key={node.id}>
            <input
              aria-label={`${name} key`}
              disabled={disabled || !editable}
              onChange={(event) => safePatch(
                () => replaceKeyValueArgument(parsed, node.id, event.target.value, pair?.value ?? ''),
                onChange,
              )}
              value={pair?.key ?? ''}
            />
            <textarea
              aria-label={`${name} value`}
              disabled={disabled || !editable}
              onChange={(event) => safePatch(
                () => replaceKeyValueArgument(parsed, node.id, pair?.key ?? '', event.target.value),
                onChange,
              )}
              rows={name === 'MESSAGE' ? 3 : 1}
              spellCheck={false}
              value={pair?.value ?? node.argument}
            />
            <button
              className="secondary-button"
              disabled={disabled || !node.structuredEditable}
              onClick={() => safePatch(() => removeDirective(parsed, node.id), onChange)}
              type="button"
            >Remove</button>
          </div>
        );
      })}
    </section>
  );
}

function TextDirective({
  parsed,
  name,
  disabled,
  onChange,
}: {
  readonly parsed: ParsedModelfile;
  readonly name: 'TEMPLATE' | 'SYSTEM' | 'LICENSE';
  readonly disabled: boolean;
  readonly onChange: (nextRaw: string) => void;
}) {
  const nodes = directiveNodes(parsed, name);
  const node = nodes[0] as ModelfileDirectiveNode | undefined;
  const text = node ? parseTextArgument(node.argument) : null;
  return (
    <section className="structured-directive-card">
      <div className="structured-directive-heading">
        <h5>{name}</h5>
        {!node ? (
          <button
            className="secondary-button"
            disabled={disabled}
            onClick={() => safePatch(() => appendDirective(parsed, name, '""""""'), onChange)}
            type="button"
          >Add {name}</button>
        ) : (
          <button
            className="secondary-button"
            disabled={disabled || !node.structuredEditable}
            onClick={() => safePatch(() => removeDirective(parsed, node.id), onChange)}
            type="button"
          >Remove</button>
        )}
      </div>
      {node && text ? (
        <textarea
          disabled={disabled || !node.structuredEditable}
          onChange={(event) => safePatch(() => replaceTextArgument(parsed, node.id, event.target.value), onChange)}
          rows={name === 'TEMPLATE' ? 8 : 5}
          spellCheck={false}
          value={text.value}
        />
      ) : <p className="muted">Not present.</p>}
    </section>
  );
}

export default function StructuredModelfileEditor({ raw, disabled, onChange }: StructuredModelfileEditorProps) {
  const parsed = useMemo(() => {
    try { return parseModelfile(raw); }
    catch { return null; }
  }, [raw]);

  if (!parsed) {
    return <p className="error-box">The draft exceeds parser bounds or contains unsupported NUL data. Continue in Raw view.</p>;
  }

  const errors = parsed.diagnostics.filter((item) => item.severity === 'error');
  const warnings = parsed.diagnostics.filter((item) => item.severity !== 'error');
  const knownCount = parsed.nodes.filter((node) => node.kind === 'directive').length;

  return (
    <div className="structured-modelfile-editor">
      <div className="structured-editor-summary">
        <span className={`status-pill ${errors.length ? 'status-danger' : 'status-ok'}`}>
          {errors.length ? `${errors.length} syntax error${errors.length === 1 ? '' : 's'}` : 'Locally parseable'}
        </span>
        <span className="status-pill status-muted">{knownCount} known directives</span>
        {parsed.hasOpaqueSyntax ? <span className="status-pill status-muted">Opaque syntax preserved</span> : null}
      </div>

      {parsed.diagnostics.length ? (
        <section className="structured-diagnostics" aria-label="Modelfile diagnostics">
          <h5>Diagnostics</h5>
          <ul>
            {[...errors, ...warnings].map((item, index) => (
              <li className={`diagnostic-${item.severity}`} key={`${item.code}:${item.range.start.offset}:${index}`}>
                {diagnosticLabel(item)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {parsed.hasOpaqueSyntax ? (
        <p className="modelfile-opaque-note">
          Unknown or opaque syntax is retained byte-for-byte. Structured controls only patch recognized safe regions; use Raw view for opaque sections.
        </p>
      ) : null}

      <div className="structured-editor-grid">
        <SimpleDirective parsed={parsed} name="FROM" disabled={disabled} onChange={onChange} />
        <SimpleDirective parsed={parsed} name="DRAFT" disabled={disabled} onChange={onChange} />
        <SimpleDirective parsed={parsed} name="RENDERER" disabled={disabled} onChange={onChange} />
        <SimpleDirective parsed={parsed} name="PARSER" disabled={disabled} onChange={onChange} />
        <SimpleDirective parsed={parsed} name="REQUIRES" disabled={disabled} onChange={onChange} />
        <KeyValueDirectives parsed={parsed} name="PARAMETER" disabled={disabled} onChange={onChange} />
        <AdapterDirectives parsed={parsed} disabled={disabled} onChange={onChange} />
        <TextDirective parsed={parsed} name="SYSTEM" disabled={disabled} onChange={onChange} />
        <TextDirective parsed={parsed} name="TEMPLATE" disabled={disabled} onChange={onChange} />
        <KeyValueDirectives parsed={parsed} name="MESSAGE" disabled={disabled} onChange={onChange} />
        <TextDirective parsed={parsed} name="LICENSE" disabled={disabled} onChange={onChange} />
      </div>
    </div>
  );
}
