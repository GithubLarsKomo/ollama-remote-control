import {
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  HELP_MODULES,
  HELP_WORKFLOWS,
  helpModule,
  type HelpModuleId,
} from './help-content.js';
import './help.css';

function ListSection({ title, items }: { readonly title: string; readonly items: readonly string[] }) {
  return (
    <section className="help-detail-section">
      <h3>{title}</h3>
      <ul>
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </section>
  );
}

export default function HelpCenter() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<HelpModuleId>('status');

  useEffect(() => {
    if (!open) return undefined;
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [open]);

  const filteredModules = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return HELP_MODULES;
    return HELP_MODULES.filter((module) => [
      module.title,
      module.eyebrow,
      module.summary,
      ...module.useWhen,
      ...module.actions,
    ].some((value) => value.toLowerCase().includes(normalized)));
  }, [query]);

  const selected = helpModule(selectedId);

  function choose(id: HelpModuleId): void {
    setSelectedId(id);
  }

  return (
    <>
      <button
        aria-haspopup="dialog"
        aria-label="Open module help"
        className="help-launcher"
        onClick={() => setOpen(true)}
        type="button"
      >
        <span aria-hidden="true">?</span>
        <span>Help</span>
      </button>

      {open ? (
        <div
          className="help-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setOpen(false);
          }}
        >
          <section
            aria-labelledby="help-center-title"
            aria-modal="true"
            className="help-center"
            role="dialog"
          >
            <header className="help-header">
              <div>
                <p className="eyebrow">Ollama Remote Control</p>
                <h2 id="help-center-title">Module help</h2>
                <p className="muted">Choose what you want to do, then open the module that matches the task.</p>
              </div>
              <button
                aria-label="Close module help"
                className="help-close"
                onClick={() => setOpen(false)}
                type="button"
              >
                ×
              </button>
            </header>

            <div className="help-workflows" aria-label="Common workflows">
              {HELP_WORKFLOWS.map((workflow) => (
                <article className="help-workflow-card" key={workflow.title}>
                  <strong>{workflow.title}</strong>
                  <p>{workflow.summary}</p>
                  <div className="help-workflow-modules">
                    {workflow.modules.map((id, index) => (
                      <span key={id}>
                        <button onClick={() => choose(id)} type="button">{helpModule(id).title}</button>
                        {index < workflow.modules.length - 1 ? <span aria-hidden="true">→</span> : null}
                      </span>
                    ))}
                  </div>
                </article>
              ))}
            </div>

            <div className="help-layout">
              <aside className="help-module-list" aria-label="Modules">
                <label>
                  Find a module
                  <input
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="e.g. logs, update, model…"
                    type="search"
                    value={query}
                  />
                </label>

                <nav aria-label="Help topics">
                  {filteredModules.map((module) => (
                    <button
                      aria-current={selectedId === module.id ? 'page' : undefined}
                      className={selectedId === module.id ? 'help-topic active' : 'help-topic'}
                      key={module.id}
                      onClick={() => choose(module.id)}
                      type="button"
                    >
                      <span>{module.title}</span>
                      <small>{module.eyebrow}</small>
                    </button>
                  ))}
                  {filteredModules.length === 0 ? (
                    <p className="help-no-results">No module matches this search.</p>
                  ) : null}
                </nav>
              </aside>

              <article className="help-detail" aria-live="polite">
                <div className="help-detail-heading">
                  <p className="eyebrow">{selected.eyebrow}</p>
                  <h2>{selected.title}</h2>
                  <p>{selected.summary}</p>
                </div>

                <div className="help-detail-grid">
                  <ListSection items={selected.useWhen} title="Use this when" />
                  <ListSection items={selected.requires} title="What it needs" />
                  <ListSection items={selected.actions} title="What it can do" />
                  <ListSection items={selected.limits} title="Limits and guardrails" />
                </div>

                {selected.next.length > 0 ? (
                  <section className="help-next">
                    <h3>Useful next modules</h3>
                    <div>
                      {selected.next.map((id) => (
                        <button className="secondary-button" key={id} onClick={() => choose(id)} type="button">
                          {helpModule(id).title}
                        </button>
                      ))}
                    </div>
                  </section>
                ) : null}
              </article>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
