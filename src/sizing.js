/* Automatic CSS-pixel sizing. The render viewport stays separate from the export bounds. */
(function (scope) {
  'use strict';

  const ROOT_ATTRIBUTE = 'data-auto-figma-root';
  const IGNORED_ELEMENTS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'NOSCRIPT']);
  const DEFAULTS = { width: 1440, height: 900 };

  function positive(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 && number <= 100000 ? number : fallback;
  }

  function parseDeclarations(text) {
    const result = {};
    let part = '', depth = 0, quote = '';
    const parts = [];
    for (const char of String(text || '')) {
      if (quote) { part += char; if (char === quote && part[part.length - 2] !== '\\') quote = ''; continue; }
      if (char === '"' || char === "'") quote = char;
      if (char === '(' || char === '[') depth++;
      if (char === ')' || char === ']') depth--;
      if (char === ';' && !depth) { parts.push(part); part = ''; } else part += char;
    }
    parts.push(part);
    for (const declaration of parts) {
      const colon = declaration.indexOf(':');
      if (colon < 1) continue;
      const name = declaration.slice(0, colon).trim().toLowerCase();
      const raw = declaration.slice(colon + 1).trim();
      const important = /\s*!important\s*$/i.test(raw);
      if (!result[name] || important || !result[name].important) {
        result[name] = { value: raw.replace(/\s*!important\s*$/i, '').trim(), important };
      }
    }
    return result;
  }

  // Detached DOMParser documents do not have CSSOM sheets. This fallback reads rule
  // blocks without confusing braces inside strings, comments, or data URLs.
  function parseRuleBlocks(css, conditional, output) {
    css = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
    let start = 0, quote = '', parens = 0;
    for (let i = 0; i < css.length; i++) {
      const char = css[i];
      if (quote) { if (char === quote && css[i - 1] !== '\\') quote = ''; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '(') parens++;
      if (char === ')') parens--;
      if (char === ';' && !parens) { start = i + 1; continue; }
      if (char !== '{' || parens) continue;
      const prelude = css.slice(start, i).trim();
      let depth = 1, end = i + 1, innerQuote = '';
      for (; end < css.length && depth; end++) {
        const c = css[end];
        if (innerQuote) { if (c === innerQuote && css[end - 1] !== '\\') innerQuote = ''; continue; }
        if (c === '"' || c === "'") { innerQuote = c; continue; }
        if (c === '{') depth++;
        if (c === '}') depth--;
      }
      const body = css.slice(i + 1, Math.max(i + 1, end - 1));
      if (/^@(media|container|supports)\b/i.test(prelude)) parseRuleBlocks(body, true, output);
      else if (/^@layer\b/i.test(prelude)) parseRuleBlocks(body, conditional, output);
      else if (prelude && prelude[0] !== '@') output.push({ selector: prelude, declarations: parseDeclarations(body), conditional });
      i = end - 1;
      start = end;
    }
  }

  function collectRules(doc) {
    const rules = [];
    const sheets = Array.from(doc.styleSheets || []);
    function visit(cssRules, conditional) {
      for (const rule of Array.from(cssRules || [])) {
        if (rule.selectorText && rule.style) rules.push({ selector: rule.selectorText, declarations: parseDeclarations(rule.style.cssText), conditional });
        else if (rule.cssRules) visit(rule.cssRules, conditional || /^(?:@media|@container|@supports)\b/i.test(rule.cssText || ''));
      }
    }
    let accessibleSheetCount = 0;
    for (const sheet of sheets) {
      try { visit(sheet.cssRules, false); accessibleSheetCount++; } catch (_) { /* A remote opaque sheet cannot establish authored dimensions. */ }
    }
    if (!accessibleSheetCount) {
      for (const style of Array.from(doc.querySelectorAll('style'))) parseRuleBlocks(style.textContent, false, rules);
    }
    return rules;
  }

  function specificity(selector) {
    // Enough to distinguish typical AI-authored root selectors; :where() contributes zero.
    selector = selector.replace(/:where\([^)]*\)/g, '').replace(/"[^"\n]*"|'[^'\n]*'/g, '');
    const ids = (selector.match(/#[\w-]+/g) || []).length;
    const classes = (selector.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) || []).length;
    const tags = (selector.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|:{1,2}[\w-]+(?:\([^)]*\))?/g, ' ').match(/\b[A-Za-z][\w-]*\b/g) || []).length;
    return ids * 1000000 + classes * 1000 + tags;
  }

  function authoredStyle(element, rules) {
    const winners = {};
    let order = 0;
    function apply(declarations, weight, conditional) {
      order++;
      for (const [name, item] of Object.entries(declarations)) {
        const candidate = { ...item, weight, order, conditional };
        const old = winners[name];
        if (!old || Number(candidate.important) > Number(old.important) ||
          (candidate.important === old.important && (candidate.weight > old.weight || candidate.weight === old.weight && candidate.order >= old.order))) winners[name] = candidate;
      }
    }
    for (const rule of rules) {
      for (const selector of rule.selector.split(',')) {
        try { if (element.matches(selector.trim())) apply(rule.declarations, specificity(selector), rule.conditional); } catch (_) { /* Unsupported selector. */ }
      }
    }
    apply(parseDeclarations(element.getAttribute('style') || element.style && element.style.cssText), 1000000000, false);
    return winners;
  }

  function value(style, name) { return style[name] && !style[name].conditional ? style[name].value : ''; }

  function px(text, element, rules) {
    if (!text) return null;
    text = text.trim();
    const variable = /^var\((--[\w-]+)(?:,\s*([^)]*))?\)$/.exec(text);
    if (variable) {
      let current = element, found = '';
      while (current && !found) { found = value(authoredStyle(current, rules), variable[1]); current = current.parentElement; }
      text = found || variable[2] || '';
    }
    const match = /^(\d+(?:\.\d+)?)px$/i.exec(text);
    return match ? positive(match[1], null) : null;
  }

  function explicitDimensions(doc) {
    const meta = doc.querySelector('meta[name="html-to-figma-viewport"]');
    if (!meta) return null;
    const match = /^\s*(\d+(?:\.\d+)?)\s*[x×,]\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(meta.getAttribute('content') || '');
    return match && positive(match[1], null) && positive(match[2], null) ? { width: +match[1], height: +match[2] } : null;
  }

  function selectorFor(element, doc) {
    if (element === doc.body) return 'body';
    if (element === doc.documentElement) return 'html';
    // Mark the detached document before serialization. Avoid ids requiring escaping.
    element.setAttribute(ROOT_ATTRIBUTE, 'design');
    return '[' + ROOT_ATTRIBUTE + '="design"]';
  }

  function rootOverride(selector, width, height, normalizePresentation) {
    const presentation = normalizePresentation
      ? 'html,body{margin:0!important;padding:0!important;min-width:0!important;max-width:none!important;min-height:0!important;max-height:none!important;display:block!important;height:auto!important;overflow:visible!important;}body{width:100%!important;}'
      : '';
    const root = selector + '{width:' + width + 'px!important;min-width:0!important;max-width:none!important;flex:none!important;margin:0!important;' +
      (height ? 'height:' + height + 'px!important;min-height:0!important;max-height:none!important;' : '') + '}';
    return presentation + root;
  }

  function infer(doc, defaults) {
    defaults = defaults || DEFAULTS;
    const fallback = { width: positive(defaults.width, DEFAULTS.width), height: positive(defaults.height, DEFAULTS.height) };
    const explicit = explicitDimensions(doc);
    const declaredRoot = doc.querySelector('[data-figma-root]');
    const base = {
      viewportWidth: explicit ? explicit.width : fallback.width,
      viewportHeight: explicit ? explicit.height : fallback.height,
      rootSelector: declaredRoot ? selectorFor(declaredRoot, doc) : null,
      designWidth: null, designHeight: null,
      reason: explicit ? 'HTML 明确声明渲染视口，按实际内容测量' : '响应式页面：默认视口推测，按实际内容测量',
      confidence: explicit ? 'explicit' : 'fallback', cssOverride: '', fixedRegion: false
    };
    const rules = collectRules(doc);
    const visibleChildren = Array.from(doc.body && doc.body.children || []).filter(el => !IGNORED_ELEMENTS.has(el.tagName));
    const singleRoot = visibleChildren.length === 1 ? visibleChildren[0] : null;
    const candidates = declaredRoot ? [declaredRoot] : [doc.body, doc.documentElement, singleRoot].filter(Boolean);
    for (const element of candidates) {
      const style = authoredStyle(element, rules);
      let width = px(value(style, 'width'), element, rules);
      let height = px(value(style, 'height'), element, rules);
      let inferredFromRatio = false;
      let calculatedFromRatio = false;
      if (!width && element === singleRoot && element !== doc.body && element !== doc.documentElement) {
        const ratio = /^(?:auto\s+)?(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(value(style, 'aspect-ratio'));
        if (height && ratio && +ratio[1] > 0 && +ratio[2] > 0) {
          width = positive(height * +ratio[1] / +ratio[2], null);
          calculatedFromRatio = !!width;
        }
        // A large unreduced ratio is an authoring clue, not proof of original resolution.
        // Small ratios such as 2/3 or 16/9 are not interpreted as pixel dimensions.
        if (!width && ratio && +ratio[1] >= 64 && +ratio[2] >= 64 && Number.isInteger(+ratio[1]) && Number.isInteger(+ratio[2]) &&
          positive(ratio[1], null) && positive(ratio[2], null)) {
          width = +ratio[1]; height = +ratio[2]; inferredFromRatio = true;
        }
      }
      if (!width) continue;
      if (!height) {
        const ratio = /^(?:auto\s+)?(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(value(style, 'aspect-ratio'));
        if (ratio && +ratio[1] > 0 && +ratio[2] > 0) {
          height = positive(width * +ratio[2] / +ratio[1], null);
          calculatedFromRatio = !!height;
        }
      }
      const rootSelector = selectorFor(element, doc);
      return {
        ...base,
        viewportWidth: explicit ? explicit.width : width,
        viewportHeight: explicit ? explicit.height : height || fallback.height,
        rootSelector, designWidth: width, designHeight: height,
        reason: inferredFromRatio ? '唯一设计区域：根据 aspect-ratio 数字推测原始尺寸' : calculatedFromRatio ? '设计根元素声明固定单边尺寸，根据 aspect-ratio 计算另一边' : height ? '设计根元素声明固定宽高' : '设计根元素声明固定宽度，按实际内容测量高度',
        confidence: inferredFromRatio ? 'inferred' : 'authored',
        cssOverride: rootOverride(rootSelector, width, height, element !== doc.body && element !== doc.documentElement),
        fixedRegion: !!height
      };
    }
    return base;
  }

  function box(element, view) {
    const rect = element.getBoundingClientRect();
    const x = rect.left + (view.scrollX || 0), y = rect.top + (view.scrollY || 0);
    return { left: x, top: y, right: x + rect.width, bottom: y + rect.height };
  }

  function measuredSize(minimum, maximum) {
    const size = maximum - minimum;
    return Math.abs(size - Math.round(size)) < 0.02 ? Math.max(1, Math.round(size)) : Math.max(1, Math.ceil(size));
  }

  function measure(doc, decision) {
    const view = doc.defaultView || { scrollX: 0, scrollY: 0, getComputedStyle: el => el.style || {} };
    const root = decision.rootSelector ? doc.querySelector(decision.rootSelector) : doc.body || doc.documentElement;
    if (!root) throw new Error('无法找到设计根元素');
    let bounds = box(root, view);
    if (!decision.rootSelector) {
      const html = doc.documentElement, body = doc.body || html;
      bounds = {
        left: 0, top: 0,
        right: Math.max(decision.viewportWidth, html.scrollWidth || 0, body.scrollWidth || 0, bounds.right),
        bottom: Math.max(decision.viewportHeight, html.scrollHeight || 0, body.scrollHeight || 0, bounds.bottom)
      };
    }
    if (!decision.fixedRegion) {
      function walk(element, clip) {
        const computed = view.getComputedStyle(element);
        if (computed.display === 'none' || computed.visibility === 'hidden' || IGNORED_ELEMENTS.has(element.tagName)) return;
        const rect = box(element, view);
        const visible = { left: Math.max(rect.left, clip.left), top: Math.max(rect.top, clip.top), right: Math.min(rect.right, clip.right), bottom: Math.min(rect.bottom, clip.bottom) };
        if (visible.right >= visible.left && visible.bottom >= visible.top) {
          bounds.left = Math.min(bounds.left, visible.left); bounds.top = Math.min(bounds.top, visible.top);
          bounds.right = Math.max(bounds.right, visible.right); bounds.bottom = Math.max(bounds.bottom, visible.bottom);
        }
        const next = { ...clip };
        if (/^(hidden|clip|scroll|auto)$/.test(computed.overflowX || computed.overflow || '')) { next.left = Math.max(next.left, rect.left); next.right = Math.min(next.right, rect.right); }
        if (/^(hidden|clip|scroll|auto)$/.test(computed.overflowY || computed.overflow || '')) { next.top = Math.max(next.top, rect.top); next.bottom = Math.min(next.bottom, rect.bottom); }
        for (const child of Array.from(element.children || [])) walk(child, next);
      }
      walk(root, { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity });
    }
    return {
      x: bounds.left, y: bounds.top,
      width: measuredSize(bounds.left, bounds.right), height: measuredSize(bounds.top, bounds.bottom),
      rootElement: root, reason: decision.reason, confidence: decision.confidence,
      fixedRegion: !!decision.fixedRegion
    };
  }

  const api = { infer, measure, parseDeclarations };
  scope.AutoSizing = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
