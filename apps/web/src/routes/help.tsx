import type { ReactNode } from 'react';
import manual from '../content/user-manual.md?raw';
import { DesignShell } from './design-shell.js';

export interface HelpProps {
  readonly onBack: () => void;
}

interface Section {
  readonly title: string;
  readonly lines: readonly string[];
}

function splitSections(text: string): { intro: string[]; sections: Section[] } {
  const lines = text.split(/\r?\n/);
  const sections: Section[] = [];
  const intro: string[] = [];
  let current: { title: string; lines: string[] } | null = null;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current) sections.push(current);
      current = { title: line.slice(3).trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      intro.push(line);
    }
  }
  if (current) sections.push(current);
  return { intro, sections };
}

function inline(text: string): ReactNode {
  return text;
}

function renderLines(lines: readonly string[], keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let list: string[] = [];
  let code: string[] = [];
  let inCode = false;
  let codeLang = '';

  function flushList() {
    if (list.length === 0) return;
    nodes.push(
      <ul key={`${keyPrefix}-list-${nodes.length}`} className="muted">
        {list.map((item, index) => (
          <li key={`${keyPrefix}-li-${index}`}>{inline(item)}</li>
        ))}
      </ul>,
    );
    list = [];
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.startsWith('```')) {
      if (inCode) {
        nodes.push(
          <pre key={`${keyPrefix}-code-${index}`} className="mono" style={{ whiteSpace: 'pre-wrap' }}>
            {code.join('\n')}
          </pre>,
        );
        code = [];
        inCode = false;
      } else {
        flushList();
        inCode = true;
        codeLang = line.slice(3).trim();
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    if (line.startsWith('### ')) {
      flushList();
      nodes.push(<h3 key={`${keyPrefix}-h3-${index}`}>{line.slice(4)}</h3>);
      continue;
    }
    if (line.startsWith('- ')) {
      list.push(line.slice(2));
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      flushList();
      nodes.push(
        <p key={`${keyPrefix}-p-${index}`} className="muted">
          {line}
        </p>,
      );
      continue;
    }
    flushList();
    if (line.trim() === '') continue;
    nodes.push(
      <p key={`${keyPrefix}-p-${index}`} className="muted">
        {line}
      </p>,
    );
  }
  flushList();
  if (code.length > 0) {
    nodes.push(
      <pre key={`${keyPrefix}-code-last`} data-lang={codeLang} className="mono">
        {code.join('\n')}
      </pre>,
    );
  }
  return nodes;
}

export function Help({ onBack }: HelpProps) {
  const { sections } = splitSections(manual);
  return (
    <DesignShell
      active="help"
      eyebrow="Help"
      title="用户手册"
      subtitle="平台使用、Agent 安装、安全建议与故障排查。"
      onBack={onBack}
    >
      <section className="grid grid-3">
        <article className="card">
          <div className="card-body">
            <div className="eyebrow">快速开始</div>
            <p className="muted">登录 → 选租户 → 新建会话 → 处理审批。</p>
          </div>
        </article>
        <article className="card">
          <div className="card-body">
            <div className="eyebrow">Agent 安装</div>
            <p className="muted">操作系统智能体页按应用系统纳管主机，展示配置发现、应用部署与 Agent 状态，并可一键生成安装命令。</p>
          </div>
        </article>
        <article className="card">
          <div className="card-body">
            <div className="eyebrow">排查</div>
            <p className="muted">加载失败、Agent 离线、安装 503/404 的排查步骤见下文。</p>
          </div>
        </article>
      </section>
      <section className="card">
        <div className="card-body">
          <h2>目录</h2>
          <div className="grid grid-2">
            {sections.map((section) => (
              <a key={section.title} className="nav-item" href={`#help-${encodeURIComponent(section.title)}`}>
                {section.title}
              </a>
            ))}
          </div>
        </div>
      </section>
      {sections.map((section) => (
        <section
          key={section.title}
          id={`help-${encodeURIComponent(section.title)}`}
          className="card"
        >
          <div className="card-body">
            <h2>{section.title}</h2>
            {renderLines(section.lines, section.title)}
          </div>
        </section>
      ))}
    </DesignShell>
  );
}
