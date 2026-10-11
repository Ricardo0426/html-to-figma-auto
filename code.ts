/**
 * HTML → Figma Auto — main thread.
 * Derived from open-htmltofigma (MIT, Kevin Bryan); see LICENSE.
 * The UI captures a browser layout in page coordinates. This thread recreates
 * editable layers, using Groups and rectangle masks for every container.
 */
interface Rgba { r: number; g: number; b: number; a: number }
type PaintSpec =
  | { type: 'SOLID'; color: Rgba }
  | { type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL'; gradientTransform: Transform; gradientStops: ColorStop[] }
  | { type: 'IMAGE'; scaleMode: 'FILL' | 'FIT'; imageRef?: string; url?: string };
interface Run {
  text: string; families: string[]; weight: number; italic: boolean;
  size: number; lineHeight: number; letterSpacing: number; color: Rgba;
  fills?: PaintSpec[]; decoration?: 'UNDERLINE' | 'STRIKETHROUGH'; textCase?: TextCase; href?: string;
}
interface HtmlNode {
  type: 'frame' | 'text' | 'svg'; name?: string; x: number; y: number; w: number; h: number;
  opacity?: number; blend?: BlendMode; fills?: PaintSpec[];
  stroke?: { color: Rgba; t: number; r: number; b: number; l: number; dash?: number[] };
  radius?: number[] | null; effects?: Effect[]; clip?: boolean;
  transform?: { m: number[]; ox: number; oy: number }; children?: HtmlNode[];
  runs?: Run[]; align?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED'; anchor?: 'LEFT' | 'CENTER' | 'RIGHT';
  autoWidth?: boolean; maxLines?: number; breaks?: number[]; svg?: string;
}
interface ImportMessage {
  type: string; jobId?: string; tree?: HtmlNode; images?: Record<string, string>;
  sourceName?: string; gap?: number; settings?: unknown; nodeId?: string; existingNodeIds?: string[];
}
interface ImportJob {
  id: string; cancelled: boolean; owned: Set<SceneNode>; work: number;
  imageWarnings: Set<string>; buildWarnings: Set<string>;
}
interface Ctx { images: Map<string, string>; font: (r?: Run) => FontName; job: ImportJob }
interface Batch { center: Vector; nextX: number | null; y: number | null; gap: number; nodes: GroupNode[] }

let activeJob: ImportJob | null = null;
let batch: Batch | null = null;
const HOST_BUILD = { version: '0.1.1', protocolVersion: 1, build: '20261011.2' };
function reply(message: object): void { figma.ui.postMessage({ ...HOST_BUILD, ...message }) }
figma.showUI(__html__, { width: 520, height: 760, themeColors: true });

figma.ui.onmessage = async (msg: ImportMessage) => {
  if (msg.type === 'hello') { reply({ type: 'host-info' }); return }
  if (msg.type === 'load-settings') {
    reply({ type: 'settings', settings: await figma.clientStorage.getAsync('auto-settings') });
    return;
  }
  if (msg.type === 'save-settings') {
    await figma.clientStorage.setAsync('auto-settings', msg.settings);
    return;
  }
  if (msg.type === 'cancel') {
    if (activeJob && (!msg.jobId || msg.jobId === activeJob.id)) activeJob.cancelled = true;
    return;
  }
  if (msg.type === 'batch-start') {
    const page = figma.currentPage;
    const nextBatch: Batch = { center: { ...figma.viewport.center }, nextX: null, y: null,
      gap: Math.max(0, Number.isFinite(msg.gap) ? msg.gap! : 120), nodes: [] };
    const existing = await Promise.all(Array.from(new Set(msg.existingNodeIds || [])).map(async (id) => {
      try { return await figma.getNodeByIdAsync(id) } catch (_) { return null }
    }));
    const groups = existing.filter((n): n is GroupNode => !!n && n.type === 'GROUP' && !n.removed
      && n.parent === page && !!n.getPluginData('html-source-size'));
    if (groups.length) {
      nextBatch.nextX = Math.max(...groups.map((n) => n.x + n.width)) + nextBatch.gap;
      nextBatch.y = Math.min(...groups.map((n) => n.y));
      nextBatch.nodes = groups;
    }
    batch = nextBatch;
    reply({ type: 'batch-ready', jobId: msg.jobId });
    return;
  }
  if (msg.type === 'batch-end') {
    const nodes = batch ? batch.nodes.filter((n) => !n.removed) : [];
    if (nodes.length) {
      figma.currentPage.selection = nodes;
      figma.viewport.scrollAndZoomIntoView(nodes);
    }
    batch = null;
    reply({ type: 'batch-done', count: nodes.length });
    return;
  }
  if (msg.type === 'locate' && msg.nodeId) {
    const node = await figma.getNodeByIdAsync(msg.nodeId);
    if (node && node.type === 'GROUP') {
      figma.currentPage.selection = [node];
      figma.viewport.scrollAndZoomIntoView([node]);
    }
    return;
  }
  // Accept the reference's old message name for callers migrating incrementally.
  if ((msg.type !== 'import' && msg.type !== 'convert') || !msg.tree) return;
  if (activeJob) {
    reply({ type: 'error', jobId: msg.jobId, message: '上一页仍在处理中，请等待完成后再导入。' });
    return;
  }
  const job: ImportJob = { id: msg.jobId || 'import', cancelled: false, owned: new Set(), work: 0,
    imageWarnings: new Set(), buildWarnings: new Set() };
  activeJob = job;
  try {
    validateTree(msg.tree);
    const [images, fonts] = await Promise.all([loadImages(msg.tree, msg.images || {}, job), loadFonts(msg.tree, job)]);
    checkCancelled(job);
    const ctx: Ctx = { images, font: fonts.get, job };
    const built = await build(msg.tree, ctx, true);
    const root = built.type === 'GROUP' ? built : own(figma.group([built], figma.currentPage), job);
    // Group bounds are computed by Figma. Reject a runtime whose mask bounds do
    // not match the design range instead of silently stretching the page.
    if (msg.tree.clip && (Math.abs(root.width - msg.tree.w) > 1 || Math.abs(root.height - msg.tree.h) > 1)) {
      throw new Error(`Figma 分组边界 ${Math.round(root.width)}×${Math.round(root.height)} 与源页面 ${Math.round(msg.tree.w)}×${Math.round(msg.tree.h)} 不一致。当前页已清理；请检查超出页面的元素或裁切蒙版。`);
    }
    root.name = (msg.sourceName || 'HTML 导入').replace(/\.html?$/i, '');
    root.setPluginData('html-source', msg.sourceName || '');
    root.setPluginData('html-source-size', JSON.stringify({ width: msg.tree.w, height: msg.tree.h }));
    checkCancelled(job);
    assertNoFrames(root);
    if (batch) {
      if (batch.nextX === null) {
        batch.nextX = Math.round(batch.center.x - root.width / 2);
        batch.y = Math.round(batch.center.y - root.height / 2);
      }
      root.x = batch.nextX;
      root.y = batch.y!;
      batch.nextX += root.width + batch.gap;
      batch.nodes.push(root);
    } else {
      const center = figma.viewport.center;
      root.x = Math.round(center.x - root.width / 2);
      root.y = Math.round(center.y - root.height / 2);
      figma.currentPage.selection = [root];
      figma.viewport.scrollAndZoomIntoView([root]);
    }
    reply({ type: 'done', jobId: job.id, nodeId: root.id, width: root.width, height: root.height,
      count: countNodes(root), frameCount: 0, fontsMissing: fonts.missing, missingFonts: fonts.missing,
      imageWarnings: Array.from(job.imageWarnings), buildWarnings: Array.from(job.buildWarnings), styles: 0 });
    job.owned.clear();
  } catch (err) {
    cleanup(job);
    reply({ type: job.cancelled ? 'cancelled' : 'error', jobId: job.id, cancelled: job.cancelled,
      message: job.cancelled ? '导入已取消，当前页面的临时图层已清理。' : err instanceof Error ? err.message : String(err) });
  } finally {
    if (activeJob === job) activeJob = null;
  }
};

function validateTree(tree: HtmlNode): void {
  let count = 0;
  walk(tree, (n) => {
    count++;
    if (count > 50000) throw new Error('页面超过 50,000 个捕获元素，请拆分后导入。');
    if (![n.x, n.y, n.w, n.h].every(Number.isFinite)) throw new Error('页面包含无效的元素坐标或尺寸。');
    if (n.w < 0 || n.h < 0 || n.w > 100000 || n.h > 100000) throw new Error('元素尺寸超出 Figma 支持的范围，请拆分页面。');
  });
  if (tree.w <= 0 || tree.h <= 0) throw new Error('页面尺寸为空。');
}
function checkCancelled(job: ImportJob): void {
  if (job.cancelled) throw new Error('Cancelled');
}
async function checkpoint(job: ImportJob): Promise<void> {
  checkCancelled(job);
  if (++job.work % 24 === 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    checkCancelled(job);
  }
}
function own<T extends SceneNode>(node: T, job: ImportJob): T { job.owned.add(node); return node }
function cleanup(job: ImportJob): void {
  for (const node of job.owned) if (!node.removed) node.remove();
  job.owned.clear();
}

/** All unfinished nodes live directly on the page; grouping preserves coordinates. */
async function build(n: HtmlNode, ctx: Ctx, isRoot = false): Promise<SceneNode> {
  await checkpoint(ctx.job);
  let node: SceneNode;
  if (n.type === 'text') {
    const text = buildText(n, ctx);
    const slack = text.textAutoResize === 'WIDTH_AND_HEIGHT' ? n.w - text.width : 0;
    const anchor = n.anchor || n.align;
    text.x = n.x + (anchor === 'CENTER' ? slack / 2 : anchor === 'RIGHT' ? slack : 0);
    text.y = n.y;
    node = text;
  } else if (n.type === 'svg') {
    node = await buildSvg(n, ctx);
  } else {
    const parts: SceneNode[] = [];
    const kids = n.children || [];
    const hasFill = !!(n.fills && n.fills.length);
    const hasStroke = !!n.stroke;
    // Real backgrounds are editable; transparent bounds preserve intentional whitespace.
    if (hasFill || isRoot || !kids.length || (n.effects && n.effects.length)) {
      const background = rectangle(n, ctx.job);
      background.name = hasFill ? '背景' : '尺寸边界（透明）';
      background.fills = paints(n.fills, ctx);
      if (isRoot) background.locked = true;
      applyRadius(background, n.radius);
      parts.push(background);
    }
    for (const child of kids) parts.push(await build(child, ctx));
    // Borders render above the contents, as a browser border does.
    if (hasStroke) {
      const border = rectangle(n, ctx.job);
      border.name = '边框';
      border.fills = [];
      applyStroke(border, n);
      applyRadius(border, n.radius);
      parts.push(border);
    }
    if (!parts.length) parts.push(rectangle(n, ctx.job));
    if (n.clip) node = maskedGroup(parts, n, ctx.job);
    else if (parts.length === 1 && !isRoot && !kids.length) node = parts[0];
    else node = own(figma.group(parts, figma.currentPage), ctx.job);
    if (n.name) node.name = n.name;
  }
  if (n.effects && n.effects.length) setEffects(node, n.effects, ctx.job);
  if (n.opacity !== undefined && 'opacity' in node) node.opacity = clamp(n.opacity, 0, 1);
  if (n.blend && 'blendMode' in node) {
    try { node.blendMode = n.blend } catch (_) { ctx.job.buildWarnings.add(`混合模式未转换：${n.blend}`) }
  }
  if (n.transform) applyTransform(node, n);
  return node;
}
function rectangle(n: Pick<HtmlNode, 'x' | 'y' | 'w' | 'h'>, job: ImportJob): RectangleNode {
  const rect = own(figma.createRectangle(), job);
  rect.resize(Math.max(n.w, 0.01), Math.max(n.h, 0.01));
  rect.x = n.x; rect.y = n.y; rect.fills = []; rect.strokes = [];
  return rect;
}
function maskedGroup(parts: SceneNode[], n: HtmlNode, job: ImportJob): GroupNode {
  const mask = rectangle(n, job);
  mask.name = '裁切蒙版'; mask.fills = [solid({ r: 1, g: 1, b: 1, a: 1 })];
  mask.isMask = true; mask.maskType = 'ALPHA'; mask.locked = true;
  applyRadius(mask, n.radius);
  // Figma masks affect subsequent siblings; grouping retains their stacking order.
  const group = own(figma.group([mask, ...parts], figma.currentPage), job);
  group.insertChild(0, mask);
  return group;
}
function buildText(n: HtmlNode, ctx: Ctx): TextNode {
  const t = own(figma.createText(), ctx.job);
  const runs = n.runs || [];
  t.name = n.name || runs.map((r) => r.text).join('').slice(0, 40) || '文字';
  t.fontName = ctx.font(runs[0]);
  t.characters = runs.map((r) => r.text).join('');
  let i = 0;
  for (const r of runs) {
    const end = i + r.text.length;
    if (end > i) {
      t.setRangeFontName(i, end, ctx.font(r));
      t.setRangeFontSize(i, end, Math.max(r.size, 1));
      t.setRangeLineHeight(i, end, { unit: 'PIXELS', value: Math.max(r.lineHeight, 0) });
      if (r.letterSpacing) t.setRangeLetterSpacing(i, end, { unit: 'PIXELS', value: r.letterSpacing });
      t.setRangeFills(i, end, r.fills ? paints(r.fills, ctx) : [solid(r.color)]);
      if (r.decoration) t.setRangeTextDecoration(i, end, r.decoration);
      if (r.textCase) t.setRangeTextCase(i, end, r.textCase);
      if (r.href) {
        try { t.setRangeHyperlink(i, end, { type: 'URL', value: r.href }) } catch (_) { /* Keep editable text. */ }
      }
    }
    i = end;
  }
  t.textAlignHorizontal = n.align || 'LEFT';
  if (n.autoWidth) t.textAutoResize = 'WIDTH_AND_HEIGHT';
  else {
    t.resize(Math.max(n.w, 1), Math.max(n.h, 1));
    t.textAutoResize = 'HEIGHT';
    const line = runs.length ? Math.min(...runs.map((r) => r.lineHeight)) || 1 : 1;
    if (n.breaks && n.breaks.length && n.align !== 'JUSTIFIED' && Math.abs(t.height - n.h) > line / 2) {
      for (const at of n.breaks.slice().sort((a, b) => b - a)) {
        let pos = Math.max(0, Math.min(at, t.characters.length));
        if (pos > 0 && t.characters[pos - 1] === ' ') { t.deleteCharacters(pos - 1, pos); pos-- }
        t.insertCharacters(pos, '\u2028', pos > 0 ? 'BEFORE' : 'AFTER');
      }
      t.textAutoResize = 'WIDTH_AND_HEIGHT';
    }
  }
  if (n.maxLines) { t.textTruncation = 'ENDING'; t.maxLines = n.maxLines }
  return t;
}

async function buildSvg(n: HtmlNode, ctx: Ctx): Promise<SceneNode> {
  let frame: FrameNode;
  try { frame = own(figma.createNodeFromSvg(n.svg || ''), ctx.job) }
  catch (_) {
    ctx.job.buildWarnings.add(`SVG 无法转换为矢量：${n.name || 'svg'}`);
    const placeholder = rectangle(n, ctx.job);
    placeholder.name = 'SVG 导入失败';
    placeholder.fills = [solid({ r: 1, g: 0.84, b: 0.87, a: 1 })];
    return placeholder;
  }
  const scaleX = Math.max(n.w, 0.01) / frame.width;
  const scaleY = Math.max(n.h, 0.01) / frame.height;
  if (Number.isFinite(scaleX) && Math.abs(scaleX - scaleY) < 0.001 && Math.abs(scaleX - 1) > 0.001) frame.rescale(scaleX);
  else if (Math.abs(scaleX - 1) > 0.01 || Math.abs(scaleY - 1) > 0.01)
    ctx.job.buildWarnings.add(`SVG 原始比例与捕获尺寸不一致：${n.name || 'svg'}`);
  frame.resize(Math.max(n.w, 0.01), Math.max(n.h, 0.01));
  frame.x = n.x; frame.y = n.y; frame.clipsContent = !!n.clip;
  const group = await replaceSvgFrames(frame, ctx.job);
  group.name = n.name || 'SVG 矢量';
  return group;
}

/** Reparent via absolute transforms so nested SVG frames never shift or lose rotation. */
async function replaceSvgFrames(frame: FrameNode, job: ImportJob): Promise<GroupNode> {
  await checkpoint(job);
  for (const child of frame.children.slice()) {
    if (child.type === 'FRAME') await replaceSvgFrames(child, job);
    else if ('children' in child) await replaceNestedFrames(child, job);
  }
  const children = frame.children.slice();
  const bounds = rectangle({ x: 0, y: 0, w: frame.width, h: frame.height }, job);
  bounds.name = frame.fills !== figma.mixed && frame.fills.length ? 'SVG 背景' : 'SVG 尺寸边界（透明）';
  bounds.fills = frame.fills === figma.mixed ? [] : frame.fills;
  bounds.strokes = frame.strokes;
  if (frame.strokeWeight !== figma.mixed) bounds.strokeWeight = frame.strokeWeight;
  else {
    bounds.strokeTopWeight = frame.strokeTopWeight; bounds.strokeRightWeight = frame.strokeRightWeight;
    bounds.strokeBottomWeight = frame.strokeBottomWeight; bounds.strokeLeftWeight = frame.strokeLeftWeight;
  }
  bounds.strokeAlign = frame.strokeAlign;
  copySvgRadius(bounds, frame);
  frame.insertChild(0, bounds);
  bounds.x = 0; bounds.y = 0; bounds.locked = true;
  let parts: SceneNode[] = [bounds, ...children];
  if (frame.clipsContent) {
    const mask = rectangle({ x: 0, y: 0, w: frame.width, h: frame.height }, job);
    mask.name = 'SVG 裁切蒙版'; mask.fills = [solid({ r: 1, g: 1, b: 1, a: 1 })];
    mask.isMask = true; mask.maskType = 'ALPHA'; mask.locked = true;
    copySvgRadius(mask, frame);
    frame.insertChild(0, mask); mask.x = 0; mask.y = 0;
    parts = [mask, ...parts];
  }
  const group = own(figma.group(parts, frame), job);
  if (frame.clipsContent) group.insertChild(0, parts[0]);
  const absolute = group.absoluteTransform;
  const parent = frame.parent;
  if (!parent || !('insertChild' in parent)) throw new Error('SVG 容器丢失。');
  const index = parent.children.indexOf(frame);
  parent.insertChild(index, group);
  group.relativeTransform = multiply(inverse('absoluteTransform' in parent ? parent.absoluteTransform : IDENTITY), absolute);
  group.name = frame.name; group.opacity = frame.opacity; group.blendMode = frame.blendMode;
  if (frame.effects.length) setEffects(group, frame.effects.slice(), job);
  group.isMask = frame.isMask; group.maskType = frame.maskType;
  frame.remove();
  return group;
}
async function replaceNestedFrames(parent: SceneNode & ChildrenMixin, job: ImportJob): Promise<void> {
  for (const child of parent.children.slice()) {
    if (child.type === 'FRAME') await replaceSvgFrames(child, job);
    else if ('children' in child) await replaceNestedFrames(child, job);
    await checkpoint(job);
  }
}
function copySvgRadius(rect: RectangleNode, frame: FrameNode): void {
  if (frame.cornerRadius !== figma.mixed) rect.cornerRadius = frame.cornerRadius;
  else {
    rect.topLeftRadius = frame.topLeftRadius; rect.topRightRadius = frame.topRightRadius;
    rect.bottomRightRadius = frame.bottomRightRadius; rect.bottomLeftRadius = frame.bottomLeftRadius;
  }
}
const IDENTITY: Transform = [[1, 0, 0], [0, 1, 0]];
function multiply(a: Transform, b: Transform): Transform {
  return [[a[0][0] * b[0][0] + a[0][1] * b[1][0], a[0][0] * b[0][1] + a[0][1] * b[1][1],
    a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2]],
  [a[1][0] * b[0][0] + a[1][1] * b[1][0], a[1][0] * b[0][1] + a[1][1] * b[1][1],
    a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2]]];
}
function inverse(m: Transform): Transform {
  const det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
  if (Math.abs(det) < 1e-9) throw new Error('SVG 包含不可逆的变换。');
  const a = m[1][1] / det, b = -m[1][0] / det, c = -m[0][1] / det, d = m[0][0] / det;
  return [[a, c, -a * m[0][2] - c * m[1][2]], [b, d, -b * m[0][2] - d * m[1][2]]];
}
/** The measured untransformed box may differ from a Group's child bounds. */
function applyTransform(node: SceneNode, n: HtmlNode): void {
  const [a, b, c, d, e, f] = n.transform!.m;
  const s = Math.hypot(a, b);
  if (s < 1e-8) return;
  const dx = node.x - n.x, dy = node.y - n.y;
  const { ox, oy } = n.transform!;
  if (Math.abs(s - 1) > 0.001 && 'rescale' in node) node.rescale(s);
  node.relativeTransform = [[a / s, c / s, n.x + ox - a * ox - c * oy + e + a * dx + c * dy],
    [b / s, d / s, n.y + oy - b * ox - d * oy + f + b * dx + d * dy]];
}

function clamp(v: number, min: number, max: number): number { return Math.max(min, Math.min(max, v)) }
function solid(c: Rgba): SolidPaint {
  return { type: 'SOLID', color: { r: clamp(c.r, 0, 1), g: clamp(c.g, 0, 1), b: clamp(c.b, 0, 1) }, opacity: clamp(c.a, 0, 1) };
}
function paints(specs: PaintSpec[] | undefined, ctx: Ctx): Paint[] {
  const out: Paint[] = [];
  for (const p of specs || []) {
    if (p.type === 'SOLID') out.push(solid(p.color));
    else if (p.type === 'IMAGE') {
      const hash = (p.imageRef && ctx.images.get(p.imageRef)) || (p.url && ctx.images.get(p.url));
      if (hash) out.push({ type: 'IMAGE', scaleMode: p.scaleMode, imageHash: hash });
      else {
        ctx.job.imageWarnings.add(`图片不可用：${(p.url || p.imageRef || '未知资源').slice(0, 250)}`);
        out.push(solid({ r: 1, g: 0.83, b: 0.86, a: 1 }));
      }
    } else out.push(p);
  }
  return out;
}
function applyStroke(node: RectangleNode, n: HtmlNode): void {
  const s = n.stroke;
  if (!s) return;
  node.strokes = [solid(s.color)]; node.strokeAlign = 'INSIDE';
  if (s.t === s.r && s.r === s.b && s.b === s.l) node.strokeWeight = Math.max(0, s.t);
  else { node.strokeTopWeight = Math.max(0, s.t); node.strokeRightWeight = Math.max(0, s.r);
    node.strokeBottomWeight = Math.max(0, s.b); node.strokeLeftWeight = Math.max(0, s.l) }
  if (s.dash) node.dashPattern = s.dash;
}
function applyRadius(node: RectangleNode, radius: number[] | null | undefined): void {
  if (!radius) return;
  const r = radius.map((v) => Math.max(0, v));
  if (r[0] === r[1] && r[1] === r[2] && r[2] === r[3]) node.cornerRadius = r[0];
  else { node.topLeftRadius = r[0]; node.topRightRadius = r[1]; node.bottomRightRadius = r[2]; node.bottomLeftRadius = r[3] }
}
function setEffects(node: SceneNode, effects: Effect[], job: ImportJob): void {
  if (!('effects' in node)) return;
  try { node.effects = effects }
  catch (_) {
    try {
      node.effects = effects.map((fx) => fx.type === 'DROP_SHADOW' || fx.type === 'INNER_SHADOW' ? { ...fx, spread: 0 } : fx);
      job.buildWarnings.add('部分阴影扩散值无法在组中表达，已保留无扩散阴影。');
    } catch (_) { job.buildWarnings.add('部分 CSS 滤镜或阴影无法转换。') }
  }
}
function walk(n: HtmlNode, fn: (n: HtmlNode) => void): void { fn(n); for (const c of n.children || []) walk(c, fn) }

async function loadImages(tree: HtmlNode, b64: Record<string, string>, job: ImportJob): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const id of Object.keys(b64)) {
    await checkpoint(job);
    try { hashes.set(id, figma.createImage(figma.base64Decode(b64[id])).hash) }
    catch (_) { job.imageWarnings.add(`图片解码失败：${id.slice(0, 200)}`) }
  }
  const urls = new Set<string>();
  walk(tree, (n) => {
    const all = (n.fills || []).concat(...(n.runs || []).map((r) => r.fills || []));
    for (const p of all) if (p.type === 'IMAGE' && p.url && !(p.imageRef && hashes.has(p.imageRef))) urls.add(p.url);
  });
  const pending = Array.from(urls);
  // Bounded concurrency avoids opening hundreds of network requests at once.
  for (let at = 0; at < pending.length; at += 4) {
    await checkpoint(job);
    await Promise.all(pending.slice(at, at + 4).map(async (url) => {
      if (!/^(https?:|data:)/i.test(url)) { job.imageWarnings.add(`无法读取图片地址：${url.slice(0, 200)}`); return }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const img = await Promise.race([
          figma.createImageAsync(url),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 15000) }),
        ]);
        hashes.set(url, img.hash);
      } catch (_) { job.imageWarnings.add(`图片加载失败：${url.slice(0, 200)}`) }
      finally { if (timer !== undefined) clearTimeout(timer) }
    }));
  }
  checkCancelled(job);
  return hashes;
}

const INTER: FontName = { family: 'Inter', style: 'Regular' };
let fontIndex: Map<string, FontName[]> | null = null;
const loadedFonts = new Set<string>();
const SYSTEM_SANS = ['SF Pro', 'SF Pro Text', 'Inter'];
const FONT_ALIASES: Record<string, string[]> = {
  'system-ui': SYSTEM_SANS, '-apple-system': SYSTEM_SANS, blinkmacsystemfont: SYSTEM_SANS, 'ui-sans-serif': SYSTEM_SANS,
  'sans-serif': ['Helvetica', 'Arial', 'Inter'], serif: ['Times New Roman', 'Times', 'Georgia', 'Noto Serif'],
  'ui-serif': ['New York', 'Times New Roman', 'Georgia'], monospace: ['Menlo', 'Courier New', 'Roboto Mono'],
  'ui-monospace': ['SF Mono', 'Menlo', 'Roboto Mono'], sfmono: ['SF Mono', 'Menlo', 'Roboto Mono'],
  'sfmono-regular': ['SF Mono', 'Menlo', 'Roboto Mono'], cursive: ['Comic Sans MS'],
};
const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-\w+|-apple-system|blinkmacsystemfont|emoji|math)$/i;
const EMOJI = /emoji|symbol/i;
async function loadFonts(tree: HtmlNode, job: ImportJob): Promise<{ get: (r?: Run) => FontName; missing: string[] }> {
  if (!fontIndex) {
    fontIndex = new Map();
    for (const f of await figma.listAvailableFontsAsync()) {
      const key = f.fontName.family.toLowerCase();
      const list = fontIndex.get(key);
      if (list) list.push(f.fontName); else fontIndex.set(key, [f.fontName]);
    }
  }
  checkCancelled(job);
  const index = fontIndex;
  const fontId = (f: FontName) => f.family + '::' + f.style;
  const runKey = (r: Run) => r.families.join(',') + '|' + r.weight + '|' + r.italic;
  const chosen = new Map<string, FontName>();
  const missing = new Set<string>();
  let fallback = pickStyle(index.get('inter') || Array.from(index.values())[0] || [INTER], 400, false);
  walk(tree, (n) => {
    for (const r of n.runs || []) {
      const key = runKey(r);
      if (chosen.has(key)) continue;
      let styles: FontName[] | undefined;
      for (const family of r.families) {
        if (EMOJI.test(family)) continue;
        for (const cand of FONT_ALIASES[family.toLowerCase()] || [family]) {
          styles = index.get(cand.toLowerCase());
          if (styles) break;
        }
        if (styles) break;
        if (!GENERIC.test(family)) missing.add(family);
      }
      chosen.set(key, pickStyle(styles || [fallback], r.weight, r.italic));
    }
  });
  const unique = new Map<string, FontName>();
  chosen.forEach((f) => unique.set(fontId(f), f));
  unique.set(fontId(fallback), fallback);
  const failed = new Set<string>();
  await Promise.all(Array.from(unique.entries()).map(async ([key, f]) => {
    if (loadedFonts.has(key)) return;
    try { await figma.loadFontAsync(f); loadedFonts.add(key) }
    catch (_) { failed.add(key); missing.add(f.family + ' / ' + f.style) }
  }));
  checkCancelled(job);
  if (!loadedFonts.has(fontId(fallback))) {
    const available = Array.from(unique.values()).find((f) => loadedFonts.has(fontId(f)));
    if (available) fallback = available;
    else {
      try { await figma.loadFontAsync(INTER); fallback = INTER; loadedFonts.add(fontId(INTER)) }
      catch (_) { throw new Error('Figma 无法加载文字字体，请检查字体服务后重试。') }
    }
  }
  return { get: (r) => { const f = r && chosen.get(runKey(r)); return f && !failed.has(fontId(f)) ? f : fallback },
    missing: Array.from(missing) };
}
function styleWeight(style: string): number {
  const s = style.toLowerCase().replace(/[\s_-]/g, '');
  if (/thin|hairline/.test(s)) return 100;
  if (/(extra|ultra)light/.test(s)) return 200;
  if (/light/.test(s)) return 300;
  if (/medium/.test(s)) return 500;
  if (/(semi|demi)bold/.test(s)) return 600;
  if (/(extra|ultra)bold/.test(s)) return 800;
  if (/black|heavy/.test(s)) return 900;
  if (/bold/.test(s)) return 700;
  return 400;
}
function pickStyle(styles: FontName[], weight: number, italic: boolean): FontName {
  let best = styles[0], bestScore = Infinity;
  for (const f of styles) {
    const extra = f.style.replace(/italic|oblique|regular|normal|book|roman|thin|hairline|extra|ultra|semi|demi|light|medium|bold|black|heavy/gi, '').trim();
    const score = Math.abs(styleWeight(f.style) - weight) + (/italic|oblique/i.test(f.style) !== italic ? 1000 : 0) + (extra ? 50 : 0);
    if (score < bestScore) { best = f; bestScore = score }
  }
  return best;
}
function assertNoFrames(node: SceneNode): void {
  if (node.type === 'FRAME') throw new Error('导入结果仍包含 Frame，已清理当前页面。');
  if ('children' in node) for (const child of node.children) assertNoFrames(child);
}
function countNodes(node: BaseNode): number {
  let count = 1;
  if ('children' in node) for (const child of node.children) count += countNodes(child);
  return count;
}
