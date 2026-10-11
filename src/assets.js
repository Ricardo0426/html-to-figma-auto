(function (scope) {
  "use strict";

  const MIME = {
    html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript",
    svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp",
    ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf",
    otf: "font/otf", eot: "application/vnd.ms-fontobject", mp4: "video/mp4",
    mp3: "audio/mpeg", ogg: "audio/ogg", pdf: "application/pdf"
  };

  function decodePath(value) {
    return value.split("/").map(part => {
      try { return decodeURIComponent(part); } catch (_) { return part; }
    }).join("/");
  }

  function normalizePath(value) {
    const pieces = String(value || "").replace(/\\/g, "/").split("/");
    const output = [];
    for (const piece of pieces) {
      if (!piece || piece === ".") continue;
      if (piece === "..") {
        if (!output.length) return null;
        output.pop();
      } else {
        output.push(piece);
      }
    }
    return output.join("/");
  }

  function referenceParts(value) {
    const reference = String(value || "").trim();
    const hashAt = reference.indexOf("#");
    const fragment = hashAt >= 0 ? reference.slice(hashAt) : "";
    const withoutHash = hashAt >= 0 ? reference.slice(0, hashAt) : reference;
    const queryAt = withoutHash.indexOf("?");
    const path = queryAt >= 0 ? withoutHash.slice(0, queryAt) : withoutHash;
    return { reference, path, fragment };
  }

  function referenceKind(reference) {
    const value = String(reference || "").trim();
    if (!value || value[0] === "#") return "anchor";
    if (/^(?:data:|blob:)/i.test(value)) return "embedded";
    if (/^(?:https?:)?\/\//i.test(value)) return "remote";
    if (/^file:/i.test(value) || /^[a-z]:[\\/]/i.test(value)) return "absolute-file";
    if (/^[a-z][a-z\d+.-]*:/i.test(value)) return "scheme";
    return "local";
  }

  function resolvePath(reference, sourcePath) {
    if (referenceKind(reference) !== "local") return null;
    const parts = referenceParts(reference);
    const decoded = decodePath(parts.path.replace(/\\/g, "/"));
    const source = normalizePath(sourcePath);
    if (source === null || !decoded) return null;
    const directory = source.includes("/") ? source.slice(0, source.lastIndexOf("/") + 1) : "";
    return normalizePath(decoded[0] === "/" ? decoded : directory + decoded);
  }

  function createIndex(files) {
    const records = Array.from(files || []).map(file => ({
      file,
      path: String(file.webkitRelativePath || file.path || file.name || "").replace(/\\/g, "/"),
      hasDirectoryRoot: !!file.webkitRelativePath
    })).filter(record => record.path);
    // A directory picker prepends the selected directory. ZIP paths already start at its root.
    const firstRoot = records.length ? records[0].path.split("/")[0] : "";
    const stripRoot = records.length > 0 && records.every(record =>
      record.hasDirectoryRoot && record.path.includes("/") && record.path.split("/")[0] === firstRoot);
    const index = {
      entries: new Map(), caseEntries: new Map(), rootName: stripRoot ? firstRoot : "",
      warnings: [], textCache: new Map(), dataCache: new Map()
    };
    for (const record of records) {
      const path = normalizePath(stripRoot ? record.path.slice(firstRoot.length + 1) : record.path);
      if (path === null || !path) {
        index.warnings.push({ kind: "invalid-path", source: record.path, reference: record.path,
          resolvedPath: null, message: "文件路径超出选择的文件夹，已忽略。" });
        continue;
      }
      if (index.entries.has(path)) {
        index.warnings.push({ kind: "duplicate-path", source: path, reference: path,
          resolvedPath: path, message: "存在重复完整路径，保留第一个文件。" });
        continue;
      }
      index.entries.set(path, { path, file: record.file, name: path.split("/").pop() });
      const key = path.toLocaleLowerCase("en-US");
      if (!index.caseEntries.has(key)) index.caseEntries.set(key, []);
      index.caseEntries.get(key).push(path);
    }
    return index;
  }

  function discoverPages(index) {
    return Array.from(index.entries.values()).filter(entry =>
      /\.html?$/i.test(entry.path) && !/(?:^|\/)(?:node_modules|\.git)(?:\/|$)/i.test(entry.path)
    ).sort((a, b) => a.path.localeCompare(b.path, "zh-CN", { numeric: true }));
  }

  function resolveReference(reference, sourcePath, index) {
    const kind = referenceKind(reference);
    if (kind === "local" && referenceKind(sourcePath) === "remote") {
      try {
        const url = new URL(reference, String(sourcePath).startsWith("//") ? "https:" + sourcePath : sourcePath).href;
        return { kind: "remote", path: null, entry: null, url, fragment: referenceParts(reference).fragment };
      } catch (_) { /* Resolve an invalid base as a local source, with the normal diagnostic. */ }
    }
    if (kind !== "local") return { kind, path: null, entry: null, fragment: referenceParts(reference).fragment };
    const path = resolvePath(reference, sourcePath);
    if (path === null) return { kind: "outside-root", path: null, entry: null, fragment: "" };
    const fragment = referenceParts(reference).fragment;
    if (index.entries.has(path)) return { kind: "local", path, entry: index.entries.get(path), fragment };
    const matches = index.caseEntries.get(path.toLocaleLowerCase("en-US")) || [];
    if (matches.length === 1) return {
      kind: "case-fallback", path: matches[0], requestedPath: path,
      entry: index.entries.get(matches[0]), fragment
    };
    return { kind: matches.length > 1 ? "ambiguous-case" : "missing", path, entry: null, fragment };
  }

  function readText(index, path) {
    if (!index.textCache.has(path)) {
      const entry = index.entries.get(path);
      index.textCache.set(path, (async () => {
        if (!entry) throw new Error("找不到文件：" + path);
        return typeof entry.file.text === "function"
          ? entry.file.text() : new TextDecoder().decode(await entry.file.arrayBuffer());
      })());
    }
    return index.textCache.get(path);
  }

  function mimeType(file, path) {
    // Some browsers assign generic application/octet-stream to otherwise standard assets.
    const extension = path.split(".").pop().toLowerCase();
    return MIME[extension] || file.type || "application/octet-stream";
  }

  function base64(bytes) {
    if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
    let output = "";
    for (let i = 0; i < bytes.length; i += 16384) {
      output += String.fromCharCode.apply(null, bytes.subarray(i, i + 16384));
    }
    return btoa(output);
  }

  function textDataUrl(text, mime) {
    return "data:" + mime + ";base64," + base64(new TextEncoder().encode(text));
  }

  function readDataUrl(index, path) {
    if (!index.dataCache.has(path)) {
      const entry = index.entries.get(path);
      index.dataCache.set(path, (async () => {
        if (!entry) throw new Error("找不到文件：" + path);
        const bytes = new Uint8Array(await entry.file.arrayBuffer());
        return "data:" + mimeType(entry.file, path) + ";base64," + base64(bytes);
      })());
    }
    return index.dataCache.get(path);
  }

  function escapeXML(value) {
    return String(value).replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
    })[character]);
  }

  function missingImage(reference) {
    const name = referenceParts(reference).path.split(/[\\/]/).pop().slice(0, 44);
    return textDataUrl('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320">' +
      '<rect width="480" height="320" fill="#fff1f2"/><path d="M208 92l64 64m0-64l-64 64" stroke="#e11d48" stroke-width="6"/>' +
      '<text x="240" y="204" fill="#9f1239" text-anchor="middle" font-family="sans-serif" font-size="22">图片缺失</text>' +
      '<text x="240" y="244" fill="#9f1239" text-anchor="middle" font-family="sans-serif" font-size="15">' + escapeXML(name) + '</text></svg>', "image/svg+xml");
  }

  function newContext(index, options) {
    return { index, options: options || {}, warnings: index.warnings.slice(), warningKeys: new Set(),
      loaded: new Set(), missing: new Set(), remote: new Set(), cssCache: new Map(), svgCache: new Map(), svgCounter: 0 };
  }

  function warn(context, kind, source, reference, resolvedPath, message) {
    const key = [kind, source, reference, resolvedPath].join("\u0000");
    if (context.warningKeys.has(key)) return;
    context.warningKeys.add(key);
    context.warnings.push({ kind, source, reference, resolvedPath: resolvedPath || null, message });
  }

  function findResource(context, reference, source) {
    const result = resolveReference(reference, source, context.index);
    if (result.kind === "remote") context.remote.add(result.url || reference);
    if (result.kind === "case-fallback") warn(context, "case-fallback", source, reference, result.path,
      "文件路径的大小写不一致，已使用唯一匹配文件。建议修正源文件路径。");
    if (["missing", "outside-root", "ambiguous-case", "absolute-file"].includes(result.kind)) {
      context.missing.add(result.path || reference);
      const message = {
        missing: "找不到资源文件。请选择包含 HTML 及其资源的完整文件夹或 ZIP。",
        "outside-root": "资源引用超出所选文件夹，无法读取。",
        "ambiguous-case": "路径大小写存在多个匹配文件，无法确定应使用的资源。",
        "absolute-file": "绝对磁盘路径不能直接读取，请使用相对于所选文件夹的路径。"
      }[result.kind];
      warn(context, result.kind, source, reference, result.path, message);
    }
    return result;
  }

  async function inlineResource(reference, source, context, image, stack) {
    const result = findResource(context, reference, source);
    if (!result.entry) {
      if (!context.options.executeScripts && /^data:image\/svg\+xml(?:;[^,]*)?,/i.test(reference) && typeof DOMParser !== "undefined") {
        try {
          const hash = reference.indexOf("#");
          const data = hash >= 0 ? reference.slice(0, hash) : reference;
          const fragment = hash >= 0 ? reference.slice(hash) : "";
          const comma = data.indexOf(",");
          const header = data.slice(0, comma);
          const payload = data.slice(comma + 1);
          const svg = /;base64/i.test(header)
            ? new TextDecoder().decode(Uint8Array.from(atob(payload), character => character.charCodeAt(0)))
            : decodeURIComponent(payload);
          return textDataUrl(await rewriteSVG(svg, source, context, stack || []), "image/svg+xml") + fragment;
        } catch (error) {
          warn(context, "invalid-svg", source, "(embedded SVG)", null, "内嵌 SVG 格式无效：" + error.message);
          return image ? missingImage("内嵌 SVG") : "";
        }
      }
      return image && ["missing", "outside-root", "ambiguous-case", "absolute-file"].includes(result.kind)
        ? missingImage(reference) : result.url || reference;
    }
    try {
      let url;
      if (/\.svg$/i.test(result.path) && typeof DOMParser !== "undefined") {
        if (stack && stack.includes(result.path)) {
          warn(context, "resource-cycle", source, reference, result.path, "SVG 存在循环资源引用，已停止递归处理。");
          return image ? missingImage(reference) : "";
        }
        url = textDataUrl(await rewriteSVG(await readText(context.index, result.path), result.path, context,
          (stack || []).concat(result.path)), "image/svg+xml");
      } else {
        url = await readDataUrl(context.index, result.path);
      }
      context.loaded.add(result.path);
      return url + result.fragment;
    } catch (error) {
      context.missing.add(result.path);
      warn(context, "read-failed", source, reference, result.path, "资源读取失败：" + error.message);
      return image ? missingImage(reference) : reference;
    }
  }

  function hasModuleImports(code) {
    // A local module needs a bundler to resolve its import graph after becoming a data URL.
    // Ignore comments and string/template contents so a plain string containing "import" is harmless.
    const tokens = String(code).replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, " ");
    return /\bimport\b(?!\s*\.)|\bexport\s+(?:\*|\{)[^;]*\bfrom\b/.test(tokens);
  }

  async function loadScript(reference, source, context, type) {
    const result = findResource(context, reference, source);
    if (!result.entry) {
      return result.kind === "remote" || result.kind === "embedded"
        ? { url: result.url || reference, remote: result.kind === "remote" } : null;
    }
    try {
      const code = await readText(context.index, result.path);
      if (hasModuleImports(code)) {
        warn(context, "unsupported-module-imports", source, reference, result.path,
          "此本地模块包含 import/export 依赖。请先打包为单个脚本；当前已跳过该模块，避免丢失依赖后错误执行。");
        context.missing.add(result.path);
        return null;
      }
      context.loaded.add(result.path);
      // Retaining src preserves classic-script async/defer behavior. Data URLs also prevent
      // an embedded </script> sequence from breaking the serialized HTML document.
      return { url: textDataUrl(code, "text/javascript"), code, path: result.path };
    } catch (error) {
      context.missing.add(result.path);
      warn(context, "read-failed", source, reference, result.path, "脚本读取失败：" + error.message);
      return null;
    }
  }

  function cssUnescape(value) {
    return value.replace(/\\([0-9a-f]{1,6})(?:\r\n|[ \t\r\n\f])?|\\([^\r\n])/gi,
      (_, hex, character) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : character);
  }

  function skipCSSString(css, at) {
    const quote = css[at++];
    while (at < css.length) {
      if (css[at] === "\\") at += 2;
      else if (css[at++] === quote) return at;
    }
    return at;
  }

  function cssURLAt(css, at) {
    const prefix = /^url\s*\(/i.exec(css.slice(at));
    if (!prefix) return null;
    let position = at + prefix[0].length;
    while (/\s/.test(css[position] || "") && position < css.length) position++;
    let value;
    if (css[position] === '"' || css[position] === "'") {
      const end = skipCSSString(css, position);
      value = css.slice(position + 1, end - 1);
      position = end;
      while (/\s/.test(css[position] || "") && position < css.length) position++;
    } else {
      const start = position;
      while (position < css.length && css[position] !== ")") {
        position += css[position] === "\\" ? 2 : 1;
      }
      value = css.slice(start, position).trim();
    }
    if (css[position] !== ")") return null;
    return { start: at, end: position + 1, reference: cssUnescape(value) };
  }

  function scanCSS(css, imports) {
    const tokens = [];
    let at = 0;
    while (at < css.length) {
      if (css.slice(at, at + 2) === "/*") {
        const end = css.indexOf("*/", at + 2);
        at = end < 0 ? css.length : end + 2;
        continue;
      }
      if (css[at] === '"' || css[at] === "'") { at = skipCSSString(css, at); continue; }
      if (imports && /^@import\b/i.test(css.slice(at))) {
        const start = at;
        at += 7;
        while (/\s/.test(css[at] || "") && at < css.length) at++;
        let reference;
        if (css[at] === '"' || css[at] === "'") {
          const end = skipCSSString(css, at);
          reference = cssUnescape(css.slice(at + 1, end - 1));
          at = end;
        } else {
          const url = cssURLAt(css, at);
          if (!url) continue;
          reference = url.reference;
          at = url.end;
        }
        const conditionsStart = at;
        while (at < css.length && css[at] !== ";" && css[at] !== "{") {
          at = css[at] === '"' || css[at] === "'" ? skipCSSString(css, at) : at + 1;
        }
        if (css[at] !== ";") continue;
        tokens.push({ start, end: ++at, reference, conditions: css.slice(conditionsStart, at - 1).trim() });
        continue;
      }
      if (!imports && /[uU]/.test(css[at]) && (at === 0 || !/[\w-]/.test(css[at - 1]))) {
        const url = cssURLAt(css, at);
        if (url) { tokens.push(url); at = url.end; continue; }
      }
      at++;
    }
    return tokens;
  }

  async function replaceTokens(value, tokens, replacer) {
    let output = "", cursor = 0;
    for (const token of tokens) {
      output += value.slice(cursor, token.start) + await replacer(token);
      cursor = token.end;
    }
    return output + value.slice(cursor);
  }

  function wrapImport(css, conditions) {
    let rest = conditions.trim();
    const wrappers = [];
    const layer = /^layer(?:\(([^)]*)\))?(?:\s+|$)/i.exec(rest);
    if (layer) { wrappers.push("@layer" + (layer[1] ? " " + layer[1] : "")); rest = rest.slice(layer[0].length).trim(); }
    // supports() can contain nested parentheses; read its matching closing parenthesis.
    if (/^supports\(/i.test(rest)) {
      let depth = 1, at = 9;
      while (at < rest.length && depth) { if (rest[at] === "(") depth++; if (rest[at] === ")") depth--; at++; }
      if (!depth) { wrappers.push("@supports (" + rest.slice(9, at - 1) + ")"); rest = rest.slice(at).trim(); }
    }
    if (rest && rest.toLowerCase() !== "all") wrappers.push("@media " + rest);
    for (let i = wrappers.length - 1; i >= 0; i--) css = wrappers[i] + "{\n" + css + "\n}";
    return css;
  }

  async function rewriteCSS(css, source, context, stack) {
    stack = stack || [source];
    const imported = await replaceTokens(css, scanCSS(css, true), async token => {
      const result = findResource(context, token.reference, source);
      if (!result.entry) {
        // Preserve remote imports and turn unavailable local imports into an explicit report.
        if (result.kind === "remote" && result.url) return '@import url("' + result.url.replace(/"/g, "%22") + '") ' + token.conditions + ";";
        return result.kind === "remote" || result.kind === "embedded" ? css.slice(token.start, token.end) : "/* unavailable @import */";
      }
      if (stack.includes(result.path)) {
        warn(context, "css-cycle", source, token.reference, result.path, "CSS @import 存在循环引用，已停止递归。");
        return "/* circular @import */";
      }
      try {
        const content = await rewriteCSS(await readText(context.index, result.path), result.path, context, stack.concat(result.path));
        context.loaded.add(result.path);
        return wrapImport(content, token.conditions);
      } catch (error) {
        context.missing.add(result.path);
        warn(context, "read-failed", source, token.reference, result.path, "样式表读取失败：" + error.message);
        return "/* failed @import */";
      }
    });
    return replaceTokens(imported, scanCSS(imported, false), async token => {
      const extension = referenceParts(token.reference).path.split(".").pop().toLowerCase();
      const isImage = /^(?:svg|png|jpe?g|gif|webp|avif|bmp|ico)$/.test(extension);
      const url = await inlineResource(token.reference, source, context, isImage, stack);
      return 'url("' + String(url).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, "") + '")';
    });
  }

  function parseSrcset(srcset) {
    const items = [];
    let at = 0;
    while (at < srcset.length) {
      while (at < srcset.length && /[\s,]/.test(srcset[at])) at++;
      const start = at;
      while (at < srcset.length && !/\s/.test(srcset[at])) at++;
      let reference = srcset.slice(start, at);
      if (!reference) break;
      if (reference.endsWith(",")) { items.push({ reference: reference.replace(/,+$/, ""), descriptor: "" }); continue; }
      // Accept compact AI-generated candidate lists such as a.png,b.png. Embedded
      // data URLs contain meaningful commas and must remain one complete candidate.
      if (reference.includes(",") && !/^(?:data:|blob:)/i.test(reference)) {
        const compact = reference.split(",");
        if (compact.every(part => /\.(?:png|jpe?g|webp|gif|avif|svg)(?:[?#].*)?$/i.test(part))) {
          for (let i = 0; i < compact.length - 1; i++) items.push({ reference: compact[i], descriptor: "" });
          reference = compact[compact.length - 1];
        }
      }
      const descriptorStart = at;
      let depth = 0;
      while (at < srcset.length) {
        if (srcset[at] === "(") depth++;
        if (srcset[at] === ")") depth--;
        if (srcset[at] === "," && !depth) break;
        at++;
      }
      items.push({ reference, descriptor: srcset.slice(descriptorStart, at).trim() });
      if (srcset[at] === ",") at++;
    }
    return items;
  }

  async function inlineSrcset(srcset, source, context, stack) {
    const results = [];
    for (const item of parseSrcset(srcset)) {
      results.push(await inlineResource(item.reference, source, context, true, stack) + (item.descriptor ? " " + item.descriptor : ""));
    }
    return results.join(", ");
  }

  function hrefAttribute(element) {
    return Array.from(element.attributes || []).find(attribute => attribute.localName === "href");
  }

  async function expandUse(element, source, context, stack) {
    const attribute = hrefAttribute(element);
    if (!attribute || referenceKind(attribute.value) !== "local") return false;
    const result = findResource(context, attribute.value, source);
    if (!result.entry || !/\.svg$/i.test(result.path)) return false;
    if ((stack || []).includes(result.path)) {
      warn(context, "resource-cycle", source, attribute.value, result.path, "SVG 存在循环引用，已停止递归处理。");
      element.remove();
      return true;
    }
    try {
      const xml = await rewriteSVG(await readText(context.index, result.path), result.path, context, (stack || []).concat(result.path));
      const svgDocument = new DOMParser().parseFromString(xml, "image/svg+xml");
      const id = result.fragment ? decodePath(result.fragment.slice(1)) : "";
      const target = id ? svgDocument.getElementById(id) : svgDocument.documentElement;
      if (!target) {
        warn(context, "missing-svg-id", source, attribute.value, result.path, "SVG 中找不到引用的图形标识：" + id);
        return false;
      }
      const prefix = "auto-svg-" + (++context.svgCounter) + "-";
      const copy = element.ownerDocument.importNode(target, true);
      const nodes = [copy].concat(Array.from(copy.querySelectorAll("*")));
      for (const node of nodes) {
        if (node.id) node.id = prefix + node.id;
        for (const attr of Array.from(node.attributes || [])) {
          const value = attr.value.replace(/url\(\s*['"]?#([^)'"\s]+)['"]?\s*\)/g, "url(#" + prefix + "$1)");
          node.setAttribute(attr.name, attr.localName === "href" && value[0] === "#" ? "#" + prefix + value.slice(1) : value);
        }
      }
      const identifier = copy.id || prefix + "root";
      copy.id = identifier;
      const host = element.closest("svg");
      if (!host) return false;
      const definitions = element.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "defs");
      definitions.appendChild(copy);
      host.insertBefore(definitions, host.firstChild);
      element.setAttribute(attribute.name, "#" + identifier);
      context.loaded.add(result.path);
      return true;
    } catch (error) {
      warn(context, "read-failed", source, attribute.value, result.path, "SVG 读取失败：" + error.message);
      return false;
    }
  }

  async function rewriteDOM(document, source, context, stack) {
    for (const link of Array.from(document.querySelectorAll("link[href]"))) {
      const rel = (link.getAttribute("rel") || "").toLowerCase();
      if (rel.split(/\s+/).includes("stylesheet")) {
        const reference = link.getAttribute("href");
        const result = findResource(context, reference, source);
        if (!result.entry) {
          if (result.kind !== "remote" && result.kind !== "embedded") link.remove();
          else if (result.url) link.setAttribute("href", result.url);
          continue;
        }
        try {
          const style = document.createElement("style");
          if (link.hasAttribute("media")) style.setAttribute("media", link.getAttribute("media"));
          style.setAttribute("data-source-path", result.path);
          style.textContent = await rewriteCSS(await readText(context.index, result.path), result.path, context);
          link.replaceWith(style);
          context.loaded.add(result.path);
        } catch (error) {
          warn(context, "read-failed", source, reference, result.path, "样式表读取失败：" + error.message);
          link.remove();
        }
      } else if (/\bicon\b/.test(rel)) {
        link.setAttribute("href", await inlineResource(link.getAttribute("href"), source, context, true, stack));
      }
    }
    for (const style of Array.from(document.querySelectorAll("style"))) {
      // Already-inlined stylesheet references are absolute data URLs.
      style.textContent = await rewriteCSS(style.textContent, style.getAttribute("data-source-path") || source, context, stack);
    }
    for (const element of Array.from(document.querySelectorAll("*"))) {
      if (!context.options.executeScripts) {
        if (element.localName === "script") { element.remove(); continue; }
        for (const attribute of Array.from(element.attributes || [])) {
          const protocol = attribute.value.replace(/[\u0000-\u0020\u007f]/g, "");
          if (/^on/i.test(attribute.name) || /^javascript:/i.test(protocol)) element.removeAttribute(attribute.name);
        }
      }
      if (element.hasAttribute("style")) element.setAttribute("style", await rewriteCSS(element.getAttribute("style"), source, context, stack));
      const tag = element.localName.toLowerCase();
      if (tag === "script" && element.hasAttribute("src")) {
        const reference = element.getAttribute("src");
        const script = await loadScript(reference, source, context, element.getAttribute("type"));
        if (script) {
          element.setAttribute("data-original-src", reference);
          element.setAttribute("src", script.url);
        } else element.remove();
        continue;
      }
      if (tag === "script" && hasModuleImports(element.textContent || "")) {
        warn(context, "unsupported-module-imports", source, "(inline script)", source,
          "内联脚本包含模块依赖。请先打包为单个脚本；当前已跳过该脚本。");
        element.remove();
        continue;
      }
      if (["img", "source"].includes(tag)) {
        const lazySource = ["data-src", "data-original", "data-lazy-src", "data-url"].map(name => element.getAttribute(name)).find(Boolean);
        const current = element.getAttribute("src") || "";
        if (lazySource && (!current || /^data:image\/(?:gif|svg)/i.test(current))) element.setAttribute("src", lazySource);
        const lazySet = element.getAttribute("data-srcset") || element.getAttribute("data-lazy-srcset");
        if (lazySet) element.setAttribute("srcset", lazySet);
      }
      if (["img", "source", "video", "audio", "input", "embed"].includes(tag) && element.hasAttribute("src")) {
        const reference = element.getAttribute("src");
        if (!element.hasAttribute("data-original-src")) element.setAttribute("data-original-src", reference);
        element.setAttribute("src", await inlineResource(reference, source, context, ["img", "source", "input"].includes(tag), stack));
      }
      if (element.hasAttribute("srcset")) {
        const reference = element.getAttribute("srcset");
        if (!element.hasAttribute("data-original-srcset")) element.setAttribute("data-original-srcset", reference);
        element.setAttribute("srcset", await inlineSrcset(reference, source, context, stack));
      }
      if (element.hasAttribute("poster")) element.setAttribute("poster", await inlineResource(element.getAttribute("poster"), source, context, true, stack));
      if (element.hasAttribute("background")) element.setAttribute("background", await inlineResource(element.getAttribute("background"), source, context, true, stack));
      if (tag === "object" && element.hasAttribute("data")) element.setAttribute("data", await inlineResource(element.getAttribute("data"), source, context, true, stack));
      if (tag === "use" && await expandUse(element, source, context, stack)) continue;
      if (["image", "use", "feimage"].includes(tag)) {
        const attribute = hrefAttribute(element);
        if (attribute) element.setAttribute(attribute.name, await inlineResource(attribute.value, source, context, true, stack));
      }
    }
  }

  async function rewriteSVG(svg, source, context, stack) {
    const document = new DOMParser().parseFromString(svg, "image/svg+xml");
    if (document.querySelector("parsererror")) throw new Error("SVG 文件格式无效");
    await rewriteDOM(document, source, context, stack);
    return new XMLSerializer().serializeToString(document.documentElement);
  }

  async function prepare(html, pagePath, index, options) {
    if (typeof DOMParser === "undefined") throw new Error("HTML 资源预处理需要浏览器 DOMParser。");
    const context = newContext(index, options);
    const document = new DOMParser().parseFromString(html, "text/html");
    let source = pagePath;
    const base = document.querySelector("base[href]");
    if (base) {
      const reference = base.getAttribute("href");
      if (referenceKind(reference) === "local") {
        const resolved = resolvePath(reference.replace(/\/?$/, "/") + "__base__.html", pagePath);
        if (resolved !== null) source = resolved;
        else warn(context, "outside-root", pagePath, reference, null, "base 路径超出所选文件夹。");
      } else if (referenceKind(reference) === "remote") {
        source = String(reference).startsWith("//") ? "https:" + reference : reference;
      }
      base.remove();
    }
    await rewriteDOM(document, source, context, [pagePath]);
    return {
      html: "<!DOCTYPE html>\n" + document.documentElement.outerHTML,
      warnings: context.warnings,
      resources: { loaded: context.loaded.size, missing: context.missing.size, remote: context.remote.size }
    };
  }

  // rewriteCSS is also useful without DOMParser, for isolated resource-resolution tests.
  async function prepareCSS(css, source, index) {
    const context = newContext(index, {});
    return { css: await rewriteCSS(css, source, context), warnings: context.warnings,
      resources: { loaded: context.loaded.size, missing: context.missing.size, remote: context.remote.size } };
  }

  async function prepareScript(reference, source, index, type) {
    const context = newContext(index, { executeScripts: true });
    return { script: await loadScript(reference, source, context, type), warnings: context.warnings,
      resources: { loaded: context.loaded.size, missing: context.missing.size, remote: context.remote.size } };
  }

  const api = { createIndex, discoverPages, prepare, prepareCSS, prepareScript, resolvePath, resolveReference,
    normalizePath, referenceKind, referenceParts, parseSrcset, readText, readDataUrl };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (scope) scope.AutoAssets = api;
})(typeof window !== "undefined" ? window : globalThis);
