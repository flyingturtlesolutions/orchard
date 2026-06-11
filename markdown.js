/**
 * @file markdown.js
 * @module markdown
 *
 * Minimal, security-first markdown renderer for assistant message bodies.
 *
 * Design constraints:
 *  - HTML-escape the entire input FIRST, then apply markdown transformations
 *    on the escaped text. This guarantees any embedded HTML from the LLM is
 *    inert — `<script>` becomes `&lt;script&gt;` before any transform runs.
 *  - Only transformations we need for chat output. No tables, blockquotes,
 *    setext headers, HTML passthrough, or embed syntax.
 *  - Returns an HTML string intended for insertion via innerHTML into a
 *    container whose contents the caller controls.
 *
 * Supported:
 *  - Paragraphs (blank-line separated)
 *  - ATX headers (#, ##, ###)
 *  - Unordered lists (- or *)
 *  - Ordered lists (1. 2. 3.)
 *  - Fenced code blocks (```lang ... ```) with a Copy button
 *  - Inline code (`x`)
 *  - Bold (**x**), italic (*x* or _x_)
 *  - Links ([text](url)) — http/https/mailto only; others render as plain text
 *  - Soft breaks inside paragraphs preserved as <br>
 */

// ─── Primitive escaping ──────────────────────────────────────────────────────

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Only permit safe URL schemes. Everything else becomes a non-link.
function isSafeUrl(url) {
  const trimmed = url.trim();
  // Root-relative (single leading slash) is fine; protocol-relative (two
  // leading slashes) is not — "//evil.com" would resolve to http(s)://evil.com
  // via the current origin's scheme and defeat the scheme allowlist.
  if (trimmed.startsWith('#')) return true;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return true;
  return /^(https?:|mailto:)/i.test(trimmed);
}

// ─── Inline transforms — applied to already-HTML-escaped text ──────────────
// Order matters. Both code spans AND rendered links are extracted into
// placeholders BEFORE emphasis (bold/italic) runs, so emphasis regexes only
// see plain text — never a href value, never the contents of inline code.
//
// v2.74.111 — Pre-fix, links were inlined as full anchor markup before
// emphasis ran, so a URL containing `**` (e.g. a bolded query param in an
// LLM-emitted link) had its href corrupted by the bold rule:
//   <a href="https://example.com?a=**foo**">link</a>
//   → <a href="https://example.com?a=<strong>foo</strong>">link</a>
// No XSS (no quote breakout) but the link was broken. The placeholder
// refactor mirrors what code spans already did.

// Bold/italic applied to a text segment. Lifted out so it can run both on
// the bulk-text pass AND on link text before stashing.
function applyEmphasis(s) {
  let out = s;
  // Bold — **text**
  out = out.replace(/\*\*([^\*\n]+?)\*\*/g, '<strong>$1</strong>');
  // Italic — *text* or _text_ (underscore not inside words)
  out = out.replace(/(^|[^\w])\*([^\*\n]+?)\*(?![\w\*])/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');
  return out;
}

function renderInline(escaped) {
  let s = escaped;

  // (1) Inline code — protect contents by extracting into placeholders.
  const codeSpans = [];
  s = s.replace(/`([^`\n]+?)`/g, (_, inner) => {
    const idx = codeSpans.length;
    codeSpans.push(`<code class="md-inline-code">${inner}</code>`);
    return `\x00INLINE${idx}\x00`;
  });

  // (2) Links — [text](url). URL has already been HTML-escaped. Validate
  // scheme, apply emphasis to the text portion, then stash the fully
  // rendered anchor as a placeholder so subsequent emphasis passes can't
  // see its href.
  const linkPlaceholders = [];
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    // The url here is HTML-escaped (so & is &amp; etc.). Decode for scheme check.
    const decoded = url.replace(/&amp;/g, '&').replace(/&#39;/g, "'")
                       .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    if (!isSafeUrl(decoded)) return m; // leave literal
    const renderedText = applyEmphasis(text);
    const idx = linkPlaceholders.length;
    linkPlaceholders.push(`<a href="${url}" target="_blank" rel="noopener noreferrer">${renderedText}</a>`);
    return `\x00LINK${idx}\x00`;
  });

  // (3) Emphasis on remaining text. Safe — links and code are placeholders.
  s = applyEmphasis(s);

  // (4) Restore link placeholders.
  s = s.replace(/\x00LINK(\d+)\x00/g, (_, idx) => linkPlaceholders[parseInt(idx, 10)]);

  // (5) Restore inline code.
  s = s.replace(/\x00INLINE(\d+)\x00/g, (_, idx) => codeSpans[parseInt(idx, 10)]);

  return s;
}

// ─── Block-level parsing ────────────────────────────────────────────────────
// Input is the raw (unescaped) source. We walk line-by-line, building blocks,
// escaping text segments as we go.

export function renderMarkdown(source) {
  if (!source) return '';
  const src   = String(source).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const out   = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const start = i + 1;
      let end = start;
      while (end < lines.length && !lines[end].match(/^```\s*$/)) end++;
      const code = lines.slice(start, end).join('\n');
      const langLabel = lang ? `<span class="md-code-lang">${escHtml(lang)}</span>` : '';
      out.push(`
<div class="md-code-block" data-lang="${escHtml(lang)}">
  <div class="md-code-header">
    ${langLabel}
    <button class="md-code-copy" type="button" title="Copy code">Copy</button>
  </div>
  <pre><code class="md-code">${escHtml(code)}</code></pre>
</div>`);
      i = end + 1;
      continue;
    }

    // ATX header (#, ##, ###)
    const header = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (header) {
      const level = header[1].length;
      out.push(`<h${level} class="md-h${level}">${renderInline(escHtml(header[2]))}</h${level}>`);
      i++;
      continue;
    }

    // Unordered list — collect consecutive - or * items
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ''));
        i++;
      }
      out.push(`<ul class="md-ul">${items.map(it =>
        `<li>${renderInline(escHtml(it))}</li>`
      ).join('')}</ul>`);
      continue;
    }

    // Ordered list — collect consecutive N. items
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i++;
      }
      out.push(`<ol class="md-ol">${items.map(it =>
        `<li>${renderInline(escHtml(it))}</li>`
      ).join('')}</ol>`);
      continue;
    }

    // Blank line — paragraph separator (already handled by paragraph grouping)
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph — collect until blank line or block-level marker
    const para = [];
    while (i < lines.length && lines[i].trim() !== '' &&
           !/^(```|#{1,3}\s|[-*]\s|\d+\.\s)/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    // Soft breaks inside paragraphs become <br>
    const paraHtml = para.map(l => renderInline(escHtml(l))).join('<br>');
    out.push(`<p class="md-p">${paraHtml}</p>`);
  }

  return out.join('\n');
}

// ─── Post-render wiring ──────────────────────────────────────────────────────
// Call on a container element after innerHTML is set to wire Copy buttons
// for all code blocks inside it.

export function wireCodeCopyButtons(container) {
  container.querySelectorAll('.md-code-copy').forEach(btn => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
      const block = btn.closest('.md-code-block');
      const code  = block?.querySelector('.md-code')?.textContent ?? '';
      try {
        await navigator.clipboard.writeText(code);
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 1400);
      } catch {
        btn.textContent = 'Failed';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
      }
    });
  });
}
