import { useEffect, useRef, useState } from 'react';
import { NAV } from './nav.js';

export function GlobalSearch() {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = query.trim()
    ? NAV.filter((item) => item.label.includes(query.trim()) || item.id.includes(query.trim().toLowerCase()))
    : NAV;

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function go(id: string): void {
    setOpen(false);
    setQuery('');
    setActive(0);
    window.dispatchEvent(new CustomEvent('opsagent:navigate', { detail: id }));
  }

  return (
    <div className="global-search">
      <svg><use href="/icons.svg#i-search" /></svg>
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive((current) => Math.min(results.length - 1, current + 1));
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((current) => Math.max(0, current - 1));
          }
          if (event.key === 'Enter' && results[active]) go(results[active].id);
          if (event.key === 'Escape') {
            setOpen(false);
            inputRef.current?.blur();
          }
        }}
        placeholder="搜索功能…"
        aria-label="搜索功能"
        aria-expanded={open}
        aria-controls="global-search-results"
      />
      <kbd className="search-kbd">⌘K</kbd>
      {open ? (
        <div className="search-results" id="global-search-results" role="listbox">
          {results.length === 0 ? <div className="search-empty">没有匹配的功能</div> : null}
          {results.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={index === active}
              className={`search-result${index === active ? ' is-active' : ''}`}
              onMouseEnter={() => setActive(index)}
              onMouseDown={() => go(item.id)}
            >
              <svg><use href={`/icons.svg#i-${item.icon}`} /></svg>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
