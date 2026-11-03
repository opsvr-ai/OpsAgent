import { useState } from 'react';
import { NAV } from './nav.js';

export function GlobalSearch() {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const results = query.trim()
    ? NAV.filter((item) => item.label.includes(query.trim()) || item.id.includes(query.trim().toLowerCase()))
    : NAV;

  function go(id: string): void {
    setOpen(false);
    setQuery('');
    window.dispatchEvent(new CustomEvent('opsagent:navigate', { detail: id }));
  }

  return (
    <div className="global-search">
      <svg><use href="/icons.svg#i-search" /></svg>
      <input
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && results[0]) go(results[0].id);
          if (event.key === 'Escape') setOpen(false);
        }}
        placeholder="搜索功能…"
        aria-label="搜索功能"
      />
      {open ? (
        <div className="search-results">
          {results.length === 0 ? <div className="search-empty">没有匹配的功能</div> : null}
          {results.map((item) => (
            <button key={item.id} type="button" className="search-result" onMouseDown={() => go(item.id)}>
              <svg><use href={`/icons.svg#i-${item.icon}`} /></svg>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
