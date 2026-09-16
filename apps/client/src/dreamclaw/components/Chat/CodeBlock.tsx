// Adapted from the fixed Nova Dream CodeBlock; see PROVENANCE.json.
import { useState, useMemo, useEffect, useRef, memo } from 'react';
import type { SyntaxHighlighterProps } from 'react-syntax-highlighter';
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light';
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark';
import oneLight from 'react-syntax-highlighter/dist/esm/styles/prism/one-light';
import { Copy, Check, ChevronDown, ChevronUp } from '../../../icons';

// ── Register only the languages we actually need (~50KB vs ~800KB) ──
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import html from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker';
import toml from 'react-syntax-highlighter/dist/esm/languages/prism/toml';
import ini from 'react-syntax-highlighter/dist/esm/languages/prism/ini';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';

SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('js', javascript);
SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('ts', typescript);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('sh', bash);
SyntaxHighlighter.registerLanguage('shell', bash);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('css', css);
SyntaxHighlighter.registerLanguage('html', html);
SyntaxHighlighter.registerLanguage('xml', html);
SyntaxHighlighter.registerLanguage('yaml', yaml);
SyntaxHighlighter.registerLanguage('yml', yaml);
SyntaxHighlighter.registerLanguage('sql', sql);
SyntaxHighlighter.registerLanguage('markdown', markdown);
SyntaxHighlighter.registerLanguage('md', markdown);
SyntaxHighlighter.registerLanguage('diff', diff);
SyntaxHighlighter.registerLanguage('c', c);
SyntaxHighlighter.registerLanguage('lsl', c); // LSL closest match
SyntaxHighlighter.registerLanguage('cpp', cpp);
SyntaxHighlighter.registerLanguage('java', java);
SyntaxHighlighter.registerLanguage('rust', rust);
SyntaxHighlighter.registerLanguage('go', go);
SyntaxHighlighter.registerLanguage('dockerfile', docker);
SyntaxHighlighter.registerLanguage('docker', docker);
SyntaxHighlighter.registerLanguage('toml', toml);
SyntaxHighlighter.registerLanguage('ini', ini);
SyntaxHighlighter.registerLanguage('jsx', jsx);
SyntaxHighlighter.registerLanguage('tsx', tsx);

// ═══════════════════════════════════════════════════════════
// Code Block — Theme-aware (dark/light) matching AEGIS design
// Uses CSS variables: --aegis-code-bg, --aegis-code-header
// ═══════════════════════════════════════════════════════════

interface CodeBlockProps {
  language: string;
  code: string;
}

/** Build syntax theme from base (oneDark/oneLight) with AEGIS overrides */
function buildTheme(base: NonNullable<SyntaxHighlighterProps['style']>) {
  return {
    ...base,
    'pre[class*="language-"]': {
      ...base['pre[class*="language-"]'],
      background: 'var(--surface)',
      margin: 0,
      padding: '1em',
      borderRadius: 0,
      fontSize: '0.87em',
      direction: 'ltr' as const,
      textAlign: 'left' as const,
      whiteSpace: 'pre-wrap' as const,
      wordBreak: 'break-word' as const,
      overflowWrap: 'break-word' as const,
    },
    'code[class*="language-"]': {
      ...base['code[class*="language-"]'],
      background: 'transparent',
      direction: 'ltr' as const,
      textAlign: 'left' as const,
      whiteSpace: 'pre-wrap' as const,
      wordBreak: 'break-word' as const,
    },
  };
}

const COLLAPSE_THRESHOLD = 30; // Lines before auto-collapse
const PREVIEW_LINES = 10;     // Lines shown when collapsed

export const CodeBlock = memo(function CodeBlock({ language, code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false), [copyError, setCopyError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { setCopied(false); setCopyError(''); clearTimeout(timer.current); }, [code]);

  const totalLines = useMemo(() => code.split('\n').length, [code]);
  const isLong = totalLines > COLLAPSE_THRESHOLD;
  const [collapsed, setCollapsed] = useState(isLong);

  const displayCode = useMemo(() => {
    if (collapsed && isLong) {
      return code.split('\n').slice(0, PREVIEW_LINES).join('\n');
    }
    return code;
  }, [code, collapsed, isLong]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code); // Always copy FULL code, including collapsed lines.
      setCopied(true); setCopyError(''); clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch { setCopyError('Copy was unavailable. Select the code to copy it.'); }
  };

  const displayLang = language || 'text';

  // Pick syntax theme based on current theme
  const [isDark, setDark] = useState(() => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark');
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.dataset.theme === 'dark'));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  const theme = buildTheme(isDark ? oneDark : oneLight);

  return (
    <div className="dc-code-block" dir="ltr"
      style={{ background: 'var(--surface)' }}>
      {/* Header */}
      <div className="dc-code-header"
        style={{ background: 'var(--raised)' }}>
        <span className="dc-code-language">
          {displayLang}
          {isLong && (
            <span className="dc-code-line-count">{totalLines} lines</span>
          )}
        </span>
        <button
          onClick={handleCopy}
          className="dc-code-copy"
          title="Copy code" aria-label={copied ? "Code copied" : "Copy code"} type="button"
        >
          {copied ? (
            <>
              <Check size={16} className="dc-copy-success" />
              <span className="dc-copy-success">Copied</span>
            </>
          ) : (
            <>
              <Copy size={16} />
              <span >Copy</span>
            </>
          )}
        </button>
      </div>

      {copyError && <p role="status" className="field-error">{copyError}</p>}
      {/* Code */}
      <SyntaxHighlighter
        language={language || 'text'}
        style={theme}
        showLineNumbers={totalLines > 3}
        lineNumberStyle={{
          color: 'var(--muted)',
          fontSize: '0.78em',
          paddingRight: '1em',
          minWidth: '2.5em',
          textAlign: 'right',
        }}
        wrapLongLines
        customStyle={{
          background: 'var(--surface)',
          margin: 0,
        }}
      >
        {displayCode}
      </SyntaxHighlighter>

      {/* Collapse/Expand button */}
      {isLong && (
        <button
          onClick={() => setCollapsed(c => !c)}
          className="dc-code-expand" type="button" aria-expanded={!collapsed}
          style={{ background: 'var(--raised)' }}
        >
          {collapsed ? (
            <>
              <ChevronDown size={13} />
              Show all {totalLines} lines
            </>
          ) : (
            <>
              <ChevronUp size={13} />
              Collapse code
            </>
          )}
        </button>
      )}
    </div>
  );
});
